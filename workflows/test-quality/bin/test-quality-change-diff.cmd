@rem test-quality-change-diff for Windows: runs helpers\change-diff.ts with Bun. The Linux and macOS
@rem launcher is the extensionless test-quality-change-diff next to this file.
@bun "%~dp0..\helpers\change-diff.ts" %*
