#!/bin/bash
# Exact unified diffs of test/qa/proposed/* against the app files they copy
# (import paths mapped back to the originals). Writes test/qa/proposed/*.diff.
cd "$(dirname "$0")/../.." || exit 1
T=$(mktemp -d)
sed -e "s#'../../../server/jev.mjs'#'./jev.mjs'#" -e "s#'../../../public/lib/outline.js'#'../public/lib/outline.js'#" test/qa/proposed/semantic.mjs > "$T/semantic.mjs"
sed -e "s#'../../../public/lib/tracker.js'#'./tracker.js'#" -e "s#'../../../public/lib/lang.js'#'./lang.js'#" test/qa/proposed/follower.js > "$T/follower.js"
sed -e "s#'../../../public/lib/script.js'#'./script.js'#" test/qa/proposed/semantic-client.js > "$T/semantic-client.js"
diff -u --label a/server/semantic.mjs --label b/server/semantic.mjs server/semantic.mjs "$T/semantic.mjs" > test/qa/proposed/semantic.mjs.diff
diff -u --label a/public/lib/follower.js --label b/public/lib/follower.js public/lib/follower.js "$T/follower.js" > test/qa/proposed/follower.js.diff
diff -u --label a/public/lib/semantic-client.js --label b/public/lib/semantic-client.js public/lib/semantic-client.js "$T/semantic-client.js" > test/qa/proposed/semantic-client.js.diff
rm -rf "$T"
wc -l test/qa/proposed/*.diff
