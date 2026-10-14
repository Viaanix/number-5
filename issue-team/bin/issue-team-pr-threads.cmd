@rem issue-team-pr-threads for Windows: runs helpers\pr-threads.ts with Bun. The Linux and macOS
@rem launcher is the extensionless issue-team-pr-threads next to this file.
@bun "%~dp0..\helpers\pr-threads.ts" %*
