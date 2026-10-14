@rem test-quality-prescreen for Windows: runs helpers\prescreen.ts with Bun. The Linux and macOS
@rem launcher is the extensionless test-quality-prescreen next to this file.
@bun "%~dp0..\helpers\prescreen.ts" %*
