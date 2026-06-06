// Add a project — one clear flow: pick a folder (the in-app browser, or type an
// absolute path for a target outside the browse root), name it (defaulting to
// the folder's basename), then add it. "Supervise now" attaches a live watcher
// so a submitted task is driven; leaving it off adds the project to the durable
// catalog only (remembered, status readable, but not yet driven) — the two
// distinct stores the CLI's `loom projects add` and `loom serve` write, here
// folded into one form with an explicit toggle instead of two confusing cards.

import { Button, Checkbox, Paper, Stack, Text, TextInput, Title } from "@mantine/core";
import { useState } from "react";

import { FolderBrowser } from "../components/FolderBrowser.js";
import { api, ApiError, errText } from "../lib/api.js";

// The trailing path segment — the project's default display name. Browser-safe
// (no node:path), tolerant of either separator and a trailing slash.
function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const seg = trimmed.split(/[/\\]/).pop();
  return seg !== undefined && seg.length > 0 ? seg : p;
}

export function AddProjectView({ onAdded }: { onAdded: () => void }) {
  const [dir, setDir] = useState("");
  const [label, setLabel] = useState("");
  const [labelTouched, setLabelTouched] = useState(false);
  const [bundle, setBundle] = useState("");
  const [superviseNow, setSuperviseNow] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Setting the directory (from the browser or the manual field) auto-fills the
  // name with its basename until the operator types their own.
  const chooseDir = (p: string): void => {
    setDir(p);
    if (!labelTouched) setLabel(basename(p));
  };

  const add = async (): Promise<void> => {
    const d = dir.trim();
    if (d.length === 0) {
      setMsg("pick a folder or enter a project directory");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      // The durable catalog (remembered + named). Unavailable (501) on a server
      // started without a config home — then we supervise only.
      let catalogued = false;
      try {
        await api<{ id: string }>("POST", "/workspace/projects", {
          dir: d,
          ...(label.trim().length > 0 ? { label: label.trim() } : {}),
          ...(bundle.trim().length > 0 ? { bundle: bundle.trim() } : {}),
        });
        catalogued = true;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 501)) throw err;
      }
      // The live watcher, when requested.
      if (superviseNow) await api<{ id: string }>("POST", "/projects", { dir: d });

      if (!catalogued && !superviseNow) {
        setMsg("the durable catalog needs a server started with a config home — enable 'supervise now'");
        return;
      }
      setMsg(
        catalogued
          ? superviseNow
            ? "added to the catalog and supervising"
            : "added to the catalog"
          : "supervising (the durable catalog is unavailable on this server)",
      );
      onAdded();
    } catch (err) {
      setMsg(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="md">
      <Title order={2}>Add a project</Title>

      <div>
        <Text size="sm" fw={600} mb={4}>
          1 · pick a folder
        </Text>
        <FolderBrowser onPick={chooseDir} />
        <TextInput
          mt="xs"
          label="…or enter a path"
          description="an absolute path (use this for a folder outside the server's browse root)"
          placeholder="/abs/path/to/project"
          value={dir}
          onChange={(e) => chooseDir(e.currentTarget.value)}
        />
      </div>

      <Paper withBorder radius="md" p="md">
        <Stack gap="sm">
          <Text size="sm" fw={600}>
            2 · name it
          </Text>
          <TextInput
            label="project name"
            description="shown everywhere instead of the path; defaults to the folder name"
            placeholder="my-service"
            value={label}
            onChange={(e) => {
              setLabel(e.currentTarget.value);
              setLabelTouched(true);
            }}
          />
          <TextInput
            label="bundle (optional)"
            placeholder="(default)"
            value={bundle}
            onChange={(e) => setBundle(e.currentTarget.value)}
          />
          <Checkbox
            label="supervise now (attach a live watcher so a submitted task is driven)"
            checked={superviseNow}
            onChange={(e) => setSuperviseNow(e.currentTarget.checked)}
          />
        </Stack>
      </Paper>

      <div>
        <Button onClick={() => void add()} loading={busy} disabled={dir.trim().length === 0}>
          add project
        </Button>
        {msg !== null && (
          <Text size="sm" c="dimmed" mt="xs">
            {msg}
          </Text>
        )}
      </div>
    </Stack>
  );
}
