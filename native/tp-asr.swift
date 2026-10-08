// tp-asr: streaming on-device speech recognition for the teleprompter,
// built on Apple's SpeechAnalyzer / SpeechTranscriber (macOS 26+).
//
// Output: one JSON object per line on stdout
//   {"type":"interim","text":...}   volatile (provisional) text
//   {"type":"final","text":...}     finalized text for a stretch of audio
//   {"type":"level","rms":...}      microphone level, ~10 per second
//   {"type":"status","state":...}   listening / stopped
//   {"type":"error","code":...,"message":...}
// Input: "stop" on stdin (or EOF) finishes cleanly.
//
// Usage:
//   tp-asr --locale zh-CN [--terms "a\u{1f}b"]        microphone
//   tp-asr --locale en-US --file speech.wav [--rate 1] audio file, real-time pace
//   tp-asr --list                                      supported / installed locales
//   tp-asr --install zh-CN                             download Apple's model

@preconcurrency import AVFoundation
import Foundation
import Speech

let outLock = NSLock()
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    outLock.lock()
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    outLock.unlock()
}

struct Options {
    var locale = "en-US"
    var file: String?
    var rate = 1.0
    var terms: [String] = []
    var list = false
    var install: String?

    static func parse() -> Options {
        var o = Options()
        var it = CommandLine.arguments.dropFirst().makeIterator()
        while let a = it.next() {
            switch a {
            case "--locale": o.locale = it.next() ?? o.locale
            case "--file": o.file = it.next()
            case "--rate": o.rate = Double(it.next() ?? "1") ?? 1
            case "--terms": o.terms = (it.next() ?? "").split(separator: "\u{1f}").map(String.init).filter { !$0.isEmpty }
            case "--list": o.list = true
            case "--install": o.install = it.next()
            default: break
            }
        }
        return o
    }
}

func bcp47(_ l: Locale) -> String { l.identifier(.bcp47) }

// "installed" means ready for the streaming configuration this helper uses.
func listLocales() async {
    let sup = await SpeechTranscriber.supportedLocales
    var ready: [String] = []
    for loc in sup {
        let t = SpeechTranscriber(locale: loc, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
        if await AssetInventory.status(forModules: [t]) == .installed { ready.append(bcp47(loc)) }
    }
    emit(["supported": sup.map(bcp47).sorted(), "installed": ready.sorted()])
}

func install(_ id: String) async -> Int32 {
    guard let loc = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: id)) else {
        emit(["type": "install", "state": "unsupported", "locale": id])
        return 2
    }
    let t = SpeechTranscriber(locale: loc, preset: .progressiveTranscription)
    do {
        if let req = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
            let progress = req.progress
            let ticker = Task {
                while !Task.isCancelled {
                    emit(["type": "install", "state": "downloading", "locale": id, "progress": progress.fractionCompleted])
                    try? await Task.sleep(nanoseconds: 500_000_000)
                }
            }
            try await req.downloadAndInstall()
            ticker.cancel()
        }
        emit(["type": "install", "state": "done", "locale": id, "progress": 1.0])
        return 0
    } catch {
        emit(["type": "install", "state": "failed", "locale": id, "message": "\(error)"])
        return 1
    }
}

func rms(_ buf: AVAudioPCMBuffer) -> Double {
    guard let ch = buf.floatChannelData, buf.frameLength > 0 else { return 0 }
    let n = Int(buf.frameLength)
    var s: Float = 0
    for i in 0..<n { s += ch[0][i] * ch[0][i] }
    return Double(sqrt(s / Float(n)))
}

// Converts incoming buffers to the analyzer's format.
final class Converter {
    let converter: AVAudioConverter
    let out: AVAudioFormat
    init?(from: AVAudioFormat, to: AVAudioFormat) {
        guard let c = AVAudioConverter(from: from, to: to) else { return nil }
        converter = c
        out = to
    }
    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let ratio = out.sampleRate / buffer.format.sampleRate
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 32)
        guard let dst = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: cap) else { return nil }
        var fed = false
        var err: NSError?
        converter.convert(to: dst, error: &err) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        return err == nil && dst.frameLength > 0 ? dst : nil
    }
}

final class LockedDate: @unchecked Sendable {
    private var t = Date.distantPast
    private let lock = NSLock()
    func elapsed() -> TimeInterval {
        lock.lock(); defer { lock.unlock() }
        return Date().timeIntervalSince(t)
    }
    func touch() {
        lock.lock(); t = Date(); lock.unlock()
    }
}

final class StopSignal: @unchecked Sendable {
    private var cont: CheckedContinuation<Void, Never>?
    private var fired = false
    private let lock = NSLock()
    var isFired: Bool {
        lock.lock(); defer { lock.unlock() }
        return fired
    }
    func wait() async {
        await withCheckedContinuation { c in
            lock.lock()
            if fired { lock.unlock(); c.resume(); return }
            cont = c
            lock.unlock()
        }
    }
    func fire() {
        lock.lock()
        fired = true
        let c = cont
        cont = nil
        lock.unlock()
        c?.resume()
    }
}

func run(_ o: Options) async -> Int32 {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: o.locale)) else {
        emit(["type": "error", "code": "unsupported-locale", "message": "Locale \(o.locale) is not supported on this Mac."])
        return 2
    }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [],
                                        reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
    if await AssetInventory.status(forModules: [transcriber]) != .installed {
        emit(["type": "error", "code": "model-not-installed", "message": "The on-device model for \(bcp47(locale)) is not installed."])
        return 3
    }

    let analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .processLifetime))
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        emit(["type": "error", "code": "format", "message": "No compatible audio format."])
        return 4
    }
    if !o.terms.isEmpty {
        let ctx = AnalysisContext()
        ctx.contextualStrings[.general] = o.terms
        try? await analyzer.setContext(ctx)
    }
    let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()

    let results = Task {
        do {
            for try await r in transcriber.results {
                let text = String(r.text.characters)
                emit(["type": r.isFinal ? "final" : "interim", "text": text])
            }
        } catch {
            emit(["type": "error", "code": "results", "message": "\(error)"])
        }
    }

    do {
        try await analyzer.prepareToAnalyze(in: format)
        try await analyzer.start(inputSequence: stream)
    } catch {
        emit(["type": "error", "code": "start", "message": "\(error)"])
        return 5
    }

    let stop = StopSignal()
    let fileMode = o.file != nil
    // stdin: "stop" ends the session; EOF (parent went away) too, except in
    // file mode, where the whole file is always processed
    Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
            if line.trimmingCharacters(in: .whitespaces) == "stop" {
                stop.fire()
                return
            }
        }
        if !fileMode { stop.fire() }
    }

    var engine: AVAudioEngine?
    if let path = o.file {
        emit(["type": "status", "state": "listening", "locale": bcp47(locale), "source": "file"])
        do {
            let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
            let inFormat = file.processingFormat
            guard let conv = Converter(from: inFormat, to: format) else { throw NSError(domain: "tp-asr", code: 1) }
            let chunk = AVAudioFrameCount(inFormat.sampleRate / 10)
            let feeder = Task.detached {
                var lastLevel = Date.distantPast
                while !stop.isFired {
                    guard let buf = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: chunk) else { break }
                    do { try file.read(into: buf, frameCount: chunk) } catch { break }
                    if buf.frameLength == 0 { break }
                    if Date().timeIntervalSince(lastLevel) > 0.1 {
                        emit(["type": "level", "rms": rms(buf)])
                        lastLevel = Date()
                    }
                    if let c = conv.convert(buf) { input.yield(AnalyzerInput(buffer: c)) }
                    try? await Task.sleep(nanoseconds: UInt64(100_000_000 / max(0.1, o.rate)))
                }
            }
            await feeder.value
        } catch {
            emit(["type": "error", "code": "file", "message": "\(error)"])
            return 6
        }
    } else {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .denied, .restricted:
            emit(["type": "error", "code": "mic-denied", "message": "Microphone access is denied for the app that launched the teleprompter."])
            return 7
        case .notDetermined:
            let ok = await AVCaptureDevice.requestAccess(for: .audio)
            if !ok {
                emit(["type": "error", "code": "mic-denied", "message": "Microphone access was not granted."])
                return 7
            }
        default: break
        }
        let e = AVAudioEngine()
        engine = e
        // (Re)installs the microphone tap; called again when the input device
        // changes (e.g. a headset or USB microphone is plugged in mid-talk).
        let lastLevel = LockedDate()
        func attach() -> Bool {
            let node = e.inputNode
            node.removeTap(onBus: 0)
            let inFormat = node.outputFormat(forBus: 0)
            guard inFormat.sampleRate > 0, let conv = Converter(from: inFormat, to: format) else { return false }
            node.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { buf, _ in
                if lastLevel.elapsed() > 0.1 {
                    emit(["type": "level", "rms": rms(buf)])
                    lastLevel.touch()
                }
                if let c = conv.convert(buf) { input.yield(AnalyzerInput(buffer: c)) }
            }
            return true
        }
        guard attach() else {
            emit(["type": "error", "code": "format", "message": "Cannot convert microphone audio."])
            return 4
        }
        do {
            e.prepare()
            try e.start()
        } catch {
            emit(["type": "error", "code": "mic", "message": "\(error)"])
            return 7
        }
        let observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: e, queue: .main) { _ in
            e.stop()
            if attach() {
                e.prepare()
                do {
                    try e.start()
                    emit(["type": "status", "state": "device-changed"])
                } catch {
                    emit(["type": "error", "code": "mic", "message": "Microphone restart failed: \(error)"])
                }
            }
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        emit(["type": "status", "state": "listening", "locale": bcp47(locale), "source": "mic"])
        await stop.wait()
    }

    engine?.inputNode.removeTap(onBus: 0)
    engine?.stop()
    input.finish()
    try? await analyzer.finalizeAndFinishThroughEndOfInput()
    _ = await results.result
    emit(["type": "status", "state": "stopped"])
    return 0
}

@main
struct TPASR {
    static func main() async {
        setvbuf(stdout, nil, _IOLBF, 0)
        let o = Options.parse()
        if o.list {
            await listLocales()
            exit(0)
        }
        if let id = o.install {
            exit(await install(id))
        }
        exit(await run(o))
    }
}
