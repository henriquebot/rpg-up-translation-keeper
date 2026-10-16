"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../scripts/main.js"), "utf8");

function harness() {
  const game = {
    system: { id: "dnd5e", version: "6.0.6" },
    user: { isGM: true },
    modules: new Map(),
    collections: new Map(),
    settings: { get() { return {}; }, register() {} }
  };
  const ctx = vm.createContext({
    Hooks: { on() {}, once() {} },
    game,
    console,
    structuredClone,
    foundry: { utils: { deepClone: structuredClone } }
  });
  vm.runInContext(source, ctx, { filename: "main.js" });
  const functions = vm.runInContext(
    "({ isTranslatablePath, buildBaselineFromAdventureSource, validateBaseline, " +
    "indexStringLeaves, getBaselineArrayIds, runTranslationMerge, previewTranslationMerge })",
    ctx
  );
  return { ...functions, game };
}

function fixture() {
  const oldJournal = {
    _id: "journal-1", name: "The Old Journal",
    pages: [{
      _id: "page-1",
      system: {
        development: { secrets: "Secret passage" },
        outcomes: [
          { id: "win", label: "Victory", summary: "You win" },
          { id: "lose", label: "Defeat", summary: "You lose" }
        ]
      }
    }]
  };
  const localJournal = structuredClone(oldJournal);
  const localOutcomes = localJournal.pages[0].system.outcomes;
  localOutcomes[0] = { label: "Vitória", summary: "Você venceu" };
  localOutcomes[1] = { label: "Derrota", summary: "Você perdeu" };
  localJournal.pages[0].system.development.secrets = "Passagem secreta";
  return { oldJournal, localJournal };
}

test("protects Ember development.secrets but never technical hook content", () => {
  const { isTranslatablePath } = harness();
  assert.equal(isTranslatablePath("JournalEntry", JSON.stringify(["system", "development", "secrets"])), true);
  assert.equal(isTranslatablePath("JournalEntry", JSON.stringify(["system", "hooks", "someHook", "name"])), false);
  assert.equal(isTranslatablePath("Macro", JSON.stringify(["command"])), false);
});

test("preserves id-less translated Outcomes only when baseline confirms stable IDs and order", () => {
  const { oldJournal, localJournal } = fixture();
  const { buildBaselineFromAdventureSource, runTranslationMerge, game } = harness();
  const baseline = buildBaselineFromAdventureSource(
    { _id: "adventure-1", journal: [oldJournal] }, { adventureId: "adventure-1" }
  );
  game.collections.set("JournalEntry", new Map([
    ["journal-1", { toObject: () => structuredClone(localJournal) }]
  ]));
  const incoming = structuredClone(oldJournal);
  const result = runTranslationMerge({ JournalEntry: [incoming] }, baseline, true);
  const system = incoming.pages[0].system;
  assert.equal(result.unsafeArrayMappings, 0);
  assert.equal(system.development.secrets, "Passagem secreta");
  assert.equal(system.outcomes[0].label, "Vitória");
  assert.equal(system.outcomes[1].summary, "Você perdeu");
  assert.ok(result.safePreservedFields >= 5);
});

test("rejects positional merge if Ember has reordered id-less local Outcomes", () => {
  const { oldJournal, localJournal } = fixture();
  const { buildBaselineFromAdventureSource, previewTranslationMerge, game } = harness();
  const baseline = buildBaselineFromAdventureSource(
    { _id: "adventure-1", journal: [oldJournal] }, { adventureId: "adventure-1" }
  );
  game.collections.set("JournalEntry", new Map([
    ["journal-1", { toObject: () => structuredClone(localJournal) }]
  ]));
  const incoming = structuredClone(oldJournal);
  incoming.pages[0].system.outcomes.reverse();
  const result = previewTranslationMerge({ JournalEntry: [incoming] }, baseline);
  assert.ok(result.unsafeArrayMappings > 0, "must block ambiguous reordered outcomes");
});

test("rejects mismatched ID, pack and system; accepts a legacy baseline with matching ID", () => {
  const { oldJournal } = fixture();
  const { buildBaselineFromAdventureSource, validateBaseline } = harness();
  const adventure = { id: "adventure-1", pack: "ember.adventure" };
  const baseline = buildBaselineFromAdventureSource(
    { _id: "adventure-1", journal: [oldJournal] }, { adventureId: "adventure-1" }
  );
  assert.equal(validateBaseline(baseline, adventure), baseline);
  assert.throws(() => validateBaseline(baseline, { id: "different" }), /ID da baseline/);
  baseline.meta.pack = "unrelated.adventure";
  assert.throws(() => validateBaseline(baseline, adventure), /Compêndio diferente/);
  baseline.meta.pack = "ember.adventure";
  baseline.meta.systemId = "crucible";
  assert.throws(() => validateBaseline(baseline, adventure), /Sistema diferente/);
});

test("never substitutes a known local Outcome ID with another incoming ID", () => {
  const { indexStringLeaves } = harness();
  const old = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
  const strings = {
    [JSON.stringify([{ id: "a" }, "label"])]: "A",
    [JSON.stringify([{ id: "b" }, "label"])]: "B"
  };
  const local = [{ id: "b", label: "BE" }, { id: "a", label: "AH" }];
  const incoming = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
  const indexed = indexStringLeaves(local, incoming, strings);
  assert.equal(indexed.get(JSON.stringify([{ id: "b" }, "label"])).value, "BE");
  assert.equal(indexed.get(JSON.stringify([{ id: "a" }, "label"])).value, "AH");
});

test("module manifest has matching v14 compatibility", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../module.json"), "utf8"));
  assert.equal(manifest.version, "0.2.5");
  assert.equal(manifest.compatibility.minimum, "14");
  assert.equal(manifest.compatibility.verified, "14.369");
});