# windows

cmx2 runs natively on windows 11, on x64 and arm64. this page covers putting it on a machine, keeping it up to date, and what works differently from macos and linux. the rest of the docs apply too; read [quickstart](quickstart.md) for models, sessions and pairing.

the windows build is new. CI runs it end to end on hosted windows runners, x64 and arm64. no one has run it for long on a real desktop yet, so read [what is missing or rough](#what-is-missing-or-rough) before you rely on it.

## prerequisites

- windows 11 on x64 or arm64. the arm64 exe runs natively, not under emulation.
- git for windows. cmx2 runs every shell command in its bash.

  ```powershell
  winget install --id Git.Git -e
  ```

- ripgrep. the grep and glob tools and file search run it.

  ```powershell
  winget install BurntSushi.ripgrep.MSVC
  ```

- a way to reach a model, as in the [quickstart](quickstart.md#2-a-model).

open a new terminal after winget so both are on your `PATH`.

## install

there are no github releases yet, so you build the binaries on any machine with [bun](https://bun.sh) 1.4.3 and copy one over. on a mac, linux or windows box with a checkout:

```sh
bun install
bun scripts/build.ts --all --out <dir>
```

`<dir>` then holds a binary for every platform, `cmx2-windows-x64.exe` and `cmx2-windows-arm64.exe` among them, and a `SHA256SUMS` file. copy the exe for your machine to the windows box, and check it against `SHA256SUMS` if it crossed a network:

```powershell
Get-FileHash .\cmx2-windows-x64.exe -Algorithm SHA256
```

provider keys come from the shell you install from, because the service does not inherit your environment. set the ones you use first, then install:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
.\cmx2-windows-x64.exe serve --install
```

`serve --install` takes `--port n` and `--hostname addr`, as on the other platforms. the default is `127.0.0.1:4097`. it does four things:

- copies the exe to `%USERPROFILE%\.local\share\cmx2\bin\cmx2.exe` (`<data>\bin`; `CMX2_DATA_DIR` moves `<data>`).
- adds `<data>\bin` to your user `PATH`.
- writes the keys it found to `<data>\service.env`.
- registers and starts a task scheduler task named `dev.cmx2.serve` that runs at logon.

your `PATH` changed, so open a new terminal, then:

```powershell
cmx2 doctor
cmx2 pair
```

doctor checks git bash, git, ripgrep, long paths, the service and who holds the port. `cmx2 serve --status` says whether the task is installed and running, and `cmx2 serve --uninstall` stops everything and removes the task. sessions and data stay. the profile lives in `%USERPROFILE%\.config\cmx2\` (`CMX2_CONFIG_DIR` moves it), and the service logs to `<data>\log\serve.log`.

### a copy of cmx2 inside wsl

wsl forwards its ports to windows, so a linux cmx2 running inside wsl on port 4097 takes the port the native one wants. two daemons cannot share a port. stop the wsl one first (inside wsl, `cmx2 serve --uninstall`, or `wsl --shutdown` from windows), or give the native one another port with `server.port` in `cmx2.jsonc` or `--port`. `cmx2 doctor` says when another cmx2 holds the port, and when it is a linux one.

## upgrade

with no releases to fetch from, point `upgrade` at a build:

```powershell
cmx2 upgrade --from <dir or url>
```

`--from` takes a folder or an http url laid out like a release: `cmx2-windows-x64.exe` (or `-arm64.exe`) and `SHA256SUMS` side by side, which is what `build.ts --all --out <dir>` writes. you can serve that folder from the build machine to the windows box over a private network, for example with `python3 -m http.server 8000` in `<dir>`, and run `cmx2 upgrade --from http://<build-host>:8000`. the sums come from the same server as the exe, so they catch a broken download, not a server you should not trust. keep it on a network you control.

upgrade checks the sum, checks the new exe runs, and swaps it in. windows will not let a running exe be overwritten, but it will let one be renamed, so upgrade renames the installed `cmx2.exe` to `cmx2.exe.old-<time>` and moves the new one into its place. then it restarts the service: the supervisor starts a fresh daemon from the new exe. the `.old-*` file stays in `<data>\bin` while something still runs from it, and the next upgrade or install removes it.

## what is different on windows

- **commands run in git for windows' bash.** the shell tool, jobs, worktree setup commands and `!command` keys all use it. cmx2 finds it through the `git` on your `PATH`, then the usual install folders. it never takes `bash` from `PATH`, because on windows that is usually `C:\Windows\System32\bash.exe`, the wsl launcher, which would run the command in a linux vm. set `CMX2_GIT_BASH` to the full path of a `bash.exe` to pick one yourself. the command reaches bash through an environment variable, because windows argument quoting dropped backslashes. so a syntax error in a command is reported from `eval:`.
- **process trees are job objects.** everything a command starts goes into a windows job object, and a kill ends the whole job at once. there is no graceful SIGTERM first, so a process gets no chance to clean up. a killed job reports exit 1; cmx2 records the signal it was asked to send.
- **the service is a logon task, not a windows service.** it is a per-user task scheduler task, so it stores no password and runs only while you are logged on. it runs hidden through `conhost --headless`, and starts `cmx2 serve --supervise`, which starts the daemon and starts it again when it dies (1 s backoff, growing to 30 s). `schtasks /End` stops only the conhost and leaves the daemon running; use `cmx2 serve --uninstall` to stop it.
- **`<data>\bin` goes on your user `PATH`.** windows has no `~/.local/bin` link, so install adds the folder itself.
- **keys in `service.env` are protected by your profile's acl.** ntfs has no file mode, so the 0600 the other platforms use means nothing. only you, SYSTEM and administrators can read your profile folder. if `CMX2_DATA_DIR` points outside your profile, the file gets whatever acl that folder has.
- **desktop notes are toasts.** windows powershell sends them, so the toast is labelled "Windows PowerShell".
- **listening ports come from `netstat`.** while jobs run, cmx2 runs two `netstat` processes every 3 s to see which ports they opened.
- **path permissions ignore case**, as windows paths do. `C:\Work\*` and `c:\work\*` are the same rule, and `~\` expands like `~/`.
- **heic images need imagemagick's `magick`.** cmx2 never uses `convert` on windows, since `C:\Windows\System32\convert.exe` converts disks, not images.

## what is missing or rough

- **no terminals or tty jobs.** bun has no pty on windows, and cmx2 waits for bun to ship one rather than carry its own. `POST /pty` answers 501, and a model that asks for a tty job gets "terminals are not available on windows yet; run the command without tty (as a plain job or in the foreground)" and runs the command without one. a client that opens a terminal gets the 501.
- **no one has seen a toast on a real desktop.** the script builds the toast on CI, but a hosted runner has no desktop to show it.
- **the supervisor keeps running the old exe after an upgrade.** only the daemon is new. the supervisor moves to the new exe at your next logon or `serve --install`, and until then `cmx2.exe.old-*` stays in `<data>\bin`.
- **long paths.** with windows long paths off, a path past 260 characters fails, which deep `node_modules` in a worktree can reach. doctor warns and gives the fix: in an administrator powershell, `Set-ItemProperty -Path HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled -Value 1`, then `git config --global core.longpaths true`.
- **short 8.3 names.** a few places can still show a path as `C:\PROGRA~1\...` instead of its long name.
- **untested paths.**
  - the restart fallback, used when the daemon does not answer a restart request, never ran on CI.
  - doctor's wsl check never ran against a real wsl. with wsl's mirrored networking it can only say that no windows process owns the port.
  - CI saw the user `PATH` change, but nothing checked that a new terminal finds `cmx2`.
- **moving sessions between os families.** importing a session exported on macos or linux has a known problem with its folder path. the windows tests skip it; it is not fixed.
- **the port sweep's cost.** the two `netstat` processes every 3 s have not been measured.
- **the machine model** comes from bios strings, so a home-built pc may show none.
