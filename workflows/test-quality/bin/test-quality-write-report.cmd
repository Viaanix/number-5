@rem test-quality-write-report for Windows: runs helpers\write-report.ts with Bun. The Linux and macOS
@rem launcher is the extensionless test-quality-write-report next to this file.
@bun "%~dp0..\helpers\write-report.ts" %*
