// A recursive, schema-driven form renderer. It walks the `FormNode` model
// `classify()` derives from `GET /config/schema` and renders an editor for each
// node KIND — never for a named field. Open-keyed records (bundles, agents,
// credentials) render as add/remove key maps; fixed objects as fieldsets;
// scalars as the matching input. This is what lets one form edit any bundle's
// config without baking in agent / tier / bundle names.
//
// A masked secret value (received from a GET) is shown verbatim with a hint and
// never re-revealed; leaving it unchanged round-trips the mask, which the server
// reconciles back to the stored literal on PUT.

import { isMaskedSecret } from "../lib/mask.js";
import { pruneEmpty, type FormNode } from "../lib/schemaForm.js";
import styles from "./SchemaForm.module.css";

// Re-export the pure helper so a view can import it alongside the renderer.
export { pruneEmpty };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface SchemaFieldProps {
  node: FormNode;
  value: unknown;
  onChange: (next: unknown) => void;
  // A human label for this node (the field key, or a record entry's key).
  label?: string;
}

export function SchemaField({ node, value, onChange, label }: SchemaFieldProps) {
  switch (node.kind) {
    case "string": {
      const v = typeof value === "string" ? value : "";
      const masked = isMaskedSecret(v);
      return (
        <label className={styles.field}>
          {label !== undefined && <span className={styles.label}>{label}</span>}
          <input
            className={styles.input}
            type="text"
            value={v}
            onChange={(e) => onChange(e.target.value)}
          />
          {masked && <span className={styles.hint}>stored secret — leave to keep, type to replace</span>}
        </label>
      );
    }
    case "number": {
      const v = typeof value === "number" ? String(value) : "";
      return (
        <label className={styles.field}>
          {label !== undefined && <span className={styles.label}>{label}</span>}
          <input
            className={styles.input}
            type="number"
            step={node.integer ? 1 : "any"}
            value={v}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw.length === 0) return onChange(undefined);
              const n = Number(raw);
              onChange(Number.isFinite(n) ? n : undefined);
            }}
          />
        </label>
      );
    }
    case "boolean": {
      return (
        <label className={styles.checkField}>
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label !== undefined && <span>{label}</span>}
        </label>
      );
    }
    case "string-array": {
      const list = Array.isArray(value) ? (value as unknown[]).map((x) => String(x)) : [];
      return (
        <label className={styles.field}>
          {label !== undefined && <span className={styles.label}>{label}</span>}
          <input
            className={styles.input}
            type="text"
            value={list.join(", ")}
            placeholder="comma-separated"
            onChange={(e) => {
              const parts = e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              onChange(parts.length > 0 ? parts : undefined);
            }}
          />
        </label>
      );
    }
    case "object": {
      const obj = asRecord(value);
      return (
        <fieldset className={styles.group}>
          {label !== undefined && <legend className={styles.legend}>{label}</legend>}
          {node.fields.map((f) => (
            <SchemaField
              key={f.key}
              node={f.node}
              label={f.key}
              value={obj[f.key]}
              onChange={(next) => onChange(setKey(obj, f.key, next))}
            />
          ))}
        </fieldset>
      );
    }
    case "record": {
      return (
        <RecordEditor node={node.value} value={value} onChange={onChange} label={label} />
      );
    }
  }
}

// An open-keyed map editor: every existing key is a removable row with a nested
// editor for its value; an "add" row appends a new key. The key names are user
// data (agent names, bundle names, backend names) — nothing here is hardcoded.
function RecordEditor({
  node,
  value,
  onChange,
  label,
}: {
  node: FormNode;
  value: unknown;
  onChange: (next: unknown) => void;
  label?: string;
}) {
  const obj = asRecord(value);
  const keys = Object.keys(obj);

  const addKey = (name: string): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || Object.prototype.hasOwnProperty.call(obj, trimmed)) return;
    onChange(setKey(obj, trimmed, node.kind === "object" ? {} : node.kind === "string-array" ? [] : ""));
  };

  return (
    <fieldset className={styles.group}>
      {label !== undefined && <legend className={styles.legend}>{label}</legend>}
      {keys.length === 0 && <div className={styles.empty}>none</div>}
      {keys.map((k) => (
        <div className={styles.recordRow} key={k}>
          <div className={styles.recordKey}>
            <span className={styles.keyName}>{k}</span>
            <button
              type="button"
              className={styles.removeBtn}
              onClick={() => onChange(deleteKey(obj, k))}
              aria-label={`remove ${k}`}
            >
              remove
            </button>
          </div>
          <div className={styles.recordValue}>
            <SchemaField node={node} value={obj[k]} onChange={(next) => onChange(setKey(obj, k, next))} />
          </div>
        </div>
      ))}
      <AddKeyRow onAdd={addKey} />
    </fieldset>
  );
}

function AddKeyRow({ onAdd }: { onAdd: (name: string) => void }) {
  return (
    <form
      className={styles.addRow}
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem("key");
        if (input instanceof HTMLInputElement) {
          onAdd(input.value);
          input.value = "";
        }
      }}
    >
      <input className={styles.input} name="key" type="text" placeholder="new key" />
      <button type="submit" className={styles.addBtn}>
        add
      </button>
    </form>
  );
}

function setKey(obj: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const next = { ...obj };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function deleteKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = { ...obj };
  delete next[key];
  return next;
}
