import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const pluginDir = resolve("herdr-plugin");
const dispatcher = join(pluginDir, "dispatch.sh");

describe("Herdr plugin dispatcher", () => {
  it("declares the subagent pane entrypoint", () => {
    const manifest = readFileSync(join(pluginDir, "herdr-plugin.toml"), "utf8");
    assert.match(manifest, /^id = "pi-herdr-subagents"$/m);
    assert.match(manifest, /^version = "0\.2\.0"$/m);
    assert.match(manifest, /^min_herdr_version = "0\.8\.2"$/m);
    assert.match(manifest, /^id = "subagent"\ntitle = "Pi subagent"\nplacement = "split"$/m);
    assert.equal(
      manifest.match(
        /^command = \["bash", "-c", "exec bash \\"\$HERDR_PLUGIN_ROOT\/dispatch\.sh\\""\]$/gm,
      )?.length,
      1,
    );
  });

  it("fails with exit 64 when the launch script env var is unset", () => {
    const result = spawnSync(dispatcher, [], { env: {}, encoding: "utf8" });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /PI_HERDR_LAUNCH_SCRIPT/);
  });

  it("fails with exit 66 when the launch script is unreadable", () => {
    const result = spawnSync(dispatcher, [], {
      env: { PI_HERDR_LAUNCH_SCRIPT: "/definitely/missing/launch.sh" },
      encoding: "utf8",
    });
    assert.equal(result.status, 66);
    assert.match(result.stderr, /launch script is not readable/);
  });

  it("executes the launch script with bash", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dispatch-"));
    try {
      const launchScript = join(dir, "launch.sh");
      writeFileSync(launchScript, 'printf "launched\\n"\nexit 7\n');
      const result = spawnSync(dispatcher, [], {
        env: { PI_HERDR_LAUNCH_SCRIPT: launchScript },
        encoding: "utf8",
      });
      assert.equal(result.status, 7);
      assert.equal(result.stdout, "launched\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
