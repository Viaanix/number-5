@rem issue-team-base-ref for Windows: runs helpers\base-ref.ts with Bun. The Linux and macOS
@rem launcher is the extensionless issue-team-base-ref next to this file.
@bun "%~dp0..\helpers\base-ref.ts" %*
