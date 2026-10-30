#!/usr/bin/env node
// Entry point: runs the CLI dispatcher (src/cli.ts).
// Both `bili` and `bili-proxy` bin aliases point here, and `node dist/index.js`
// still works. The package root is also importable (exports["."] resolves to
// this file), and npm host apps import it to reach the CLI surface — opencode's
// plugin loader did exactly that, and the unguarded main() then dispatched a
// CLI against the HOST's argv: a plain TUI import defaulted to "start" and
// fought over port 8787, an `opencode run x` import hit unknown-command and
// process.exit(2)'d the host. Only dispatch when this file is the invoked
// script (same posture as the guard in claude-native-bootstrap.ts).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "./cli.js";

function invokedAsScript(): boolean {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    let self: string;
    let invoked: string;
    try {
        // realpath on BOTH sides: bin symlinks (nvm), cwd-relative invocation,
        // and --preserve-symlinks module URLs all converge to the same file.
        self = realpathSync(fileURLToPath(import.meta.url));
        invoked = realpathSync(argv1);
    } catch {
        return false;
    }
    if (process.platform === "win32") return self.toLowerCase() === invoked.toLowerCase();
    return self === invoked;
}

// #5103: "failed to start" with only the raw error dump left users digging
// through %TEMP% logs for hours — an EPERM/EACCES here is an OS-level write
// refusal (AV lock, integrity control, boot-time components), so say what
// class it is and where the fix usually lives, before exiting.
function startupFailureHints(err: unknown): string | undefined {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "EPERM" || code === "EACCES") {
        return [
            "bili: startup failed because the OS refused a file operation (a permission/lock issue, not a code fault):",
            "      - Windows: exclude %USERPROFILE%\\.local\\share\\billion-context\\ from antivirus/Defender real-time scanning (CONFIGURATION.md, AV exclusions); OneDrive placeholder files under the profile dir cause the same refusal.",
            "      - Windows: low-integrity or sandboxed launcher processes hit this via integrity control even with correct ACLs (#3823).",
            "      - Transient boot-time lockers clear on their own — retrying after a minute often succeeds.",
        ].join("\n");
    }
    return undefined;
}

if (invokedAsScript()) {
    main().catch((err) => {
        console.error("bili: failed to start:", err);
        const hints = startupFailureHints(err);
        if (hints !== undefined) console.error(hints);
        process.exit(1);
    });
}
