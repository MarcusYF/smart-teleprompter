# 智能提词器 / Smart Teleprompter

## Purpose and scope
中英文语音跟读提词器，支持可选 Jev 语义判断及 Keynote/PowerPoint 联动。
本轮交付独立 Mac 应用及公开 GitHub 仓库。

## Current state
2026-10-08：1.3.0（14）正在打包验证。独立发行目标为 Apple Silicon、macOS 26+。
前端、本地服务、Node 和识别器均随包分发；用户数据存入 Application Support。
用户已明确授权发布公开仓库 `MarcusYF/smart-teleprompter`。

## Canonical sources and outputs
- README.md：功能、使用及构建说明。
- package.json：版本与构建号。
- docs/VALIDATION.md：当前验证结果，完成测试后记录。
- HANDOFF.md：最新交接；project-memory/records/：工作记录。
- output/：本地发行产物，不提交到源码仓库。

## Next steps
完成独立包验证，发布源码和发行 ZIP，核对 GitHub 上的实际结果。
真人麦克风、双屏全屏与实体翻页器验收仍待后续实机测试。
