@rem issue-team-change-diff for Windows: runs helpers\change-diff.ts with Bun. The Linux and macOS
@rem launcher is the extensionless issue-team-change-diff next to this file.
@bun "%~dp0..\helpers\change-diff.ts" %*
