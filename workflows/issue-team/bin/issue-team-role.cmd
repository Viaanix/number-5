@rem issue-team-role for Windows: runs helpers\role.ts with Bun. The Linux and macOS
@rem launcher is the extensionless issue-team-role next to this file.
@bun "%~dp0..\helpers\role.ts" %*
