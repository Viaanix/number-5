@rem issue-team-test-prescreen for Windows: runs helpers\test-prescreen.ts with Bun. The Linux and macOS
@rem launcher is the extensionless issue-team-test-prescreen next to this file.
@bun "%~dp0..\helpers\test-prescreen.ts" %*
