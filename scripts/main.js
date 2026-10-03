const MODULE_ID = "rpg-up-translation-keeper";
const MODULE_TITLE = "RPG Up Translation Keeper";
const BACKUP_SCHEMA_VERSION = 2;
const BASELINE_SCHEMA_VERSION = 1;

const ADVENTURE_FIELDS = {
  actors: "Actor",
  combats: "Combat",
  items: "Item",
  journal: "JournalEntry",
  scenes: "Scene",
  tables: "RollTable",
  macros: "Macro",
  cards: "Cards",
  playlists: "Playlist",
  folders: "Folder"
};

let bypassContext = null;
let protectionFlowRunning = false;

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "Proteger importação de Adventures",
    hint: "Bloqueia a importação até criar um backup e preparar a preservação das traduções.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "autoRestore", {
    name: "Preservar traduções automaticamente",
    hint: "Mantém textos locais quando o texto original da Adventure não mudou e faz merge seguro de trechos HTML inalterados.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "baselines", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, "lastBackup", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });
});

Hooks.on("importAdventure", (adventure, options, created, updated) => {
  if (!bypassContext || !sameAdventure(adventure, bypassContext.adventure)) return;
  bypassContext.coreImportCompleted = true;
  bypassContext.created = created;
  bypassContext.updated = updated;
});

Hooks.once("ready", () => {
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      analyzeImport,
      buildBackupPayload,
      downloadBackup,
      getBaselineStatus,
      importBaselineFromObject,
      exportBaseline: async adventure => {
        const baseline = getStoredBaseline(adventure);
        if (!baseline) throw new Error("Nenhuma baseline salva para esta Adventure.");
        return downloadBaselineFile(adventure, baseline);
      }
    };
  }

  if (game.user?.isGM) {
    console.log(`${MODULE_TITLE} | Proteção de Adventure Import ativa.`);
  }
});

Hooks.on("preImportAdventure", (adventure, options, toCreate, toUpdate) => {
  if (!game.user?.isGM) return;
  if (!game.settings.get(MODULE_ID, "enabled")) return;

  if (bypassContext && sameAdventure(adventure, bypassContext.adventure)) {
    if (game.settings.get(MODULE_ID, "autoRestore") && bypassContext.baseline) {
      const result = applyTranslationMerge(adventure, toUpdate, bypassContext.baseline);
      bypassContext.mergeResult = result;
      console.log(`${MODULE_TITLE} | Merge aplicado antes da importação`, result);
    }
    return true;
  }

  if (protectionFlowRunning) {
    ui.notifications.warn(`${MODULE_TITLE}: já existe uma verificação de importação em andamento.`);
    return false;
  }

  protectionFlowRunning = true;

  setTimeout(async () => {
    try {
      await runProtectionFlow(adventure, options, toCreate, toUpdate);
    } catch (error) {
      console.error(`${MODULE_TITLE} | Falha no fluxo de proteção`, error);
      ui.notifications.error(`${MODULE_TITLE}: a importação foi cancelada por segurança.`);
    } finally {
      protectionFlowRunning = false;
    }
  }, 0);

  return false;
});

async function runProtectionFlow(adventure, options, toCreate, toUpdate) {
  const analysis = analyzeImport(toCreate, toUpdate);
  let baseline = getStoredBaseline(adventure);

  if (!baseline && analysis.totalUpdate > 0 && game.settings.get(MODULE_ID, "autoRestore")) {
    baseline = await requestBaselineFile(adventure);
    if (!baseline) {
      ui.notifications.warn(`${MODULE_TITLE}: sem baseline antiga, a importação foi bloqueada para não arriscar suas traduções.`);
      return;
    }

    try {
      await saveBaseline(adventure, baseline);
    } catch (error) {
      console.warn(`${MODULE_TITLE} | Não foi possível persistir a baseline no mundo`, error);
      ui.notifications.warn(`${MODULE_TITLE}: baseline carregada para esta importação, mas não foi possível salvá-la no mundo.`);
    }
  }

  const preview = baseline
    ? previewTranslationMerge(toUpdate, baseline)
    : emptyMergeStats();

  const action = await foundry.applications.api.DialogV2.wait({
    window: { title: `🛡️ ${MODULE_TITLE}` },
    content: buildAnalysisHtml(adventure, analysis, preview, Boolean(baseline)),
    modal: true,
    rejectClose: false,
    buttons: [
      {
        action: "backup",
        label: "Gerar backup e continuar",
        icon: "fa-solid fa-download",
        default: true,
        callback: () => "backup"
      },
      {
        action: "cancel",
        label: "Cancelar importação",
        icon: "fa-solid fa-ban",
        callback: () => null
      }
    ]
  });

  if (action !== "backup") {
    ui.notifications.info(`${MODULE_TITLE}: importação cancelada. Nada foi alterado.`);
    return;
  }

  const payload = buildBackupPayload(adventure, toCreate, toUpdate, analysis, preview, baseline);
  const filename = downloadBackup(payload, adventure);

  await game.settings.set(MODULE_ID, "lastBackup", {
    createdAt: payload.createdAt,
    filename,
    adventureId: payload.adventure.id,
    adventureName: payload.adventure.name,
    createCount: analysis.totalCreate,
    updateCount: analysis.totalUpdate
  });

  const proceed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Backup criado" },
    content: buildBackupConfirmationHtml(filename, preview, Boolean(baseline)),
    modal: true,
    rejectClose: false,
    yes: {
      label: baseline ? "Importar com traduções protegidas" : "Importar Adventure",
      icon: "fa-solid fa-shield-halved",
      callback: () => true
    },
    no: {
      label: "Parar aqui",
      icon: "fa-solid fa-hand",
      callback: () => false
    }
  });

  if (!proceed) {
    ui.notifications.info(`${MODULE_TITLE}: backup mantido e importação cancelada.`);
    return;
  }

  bypassContext = {
    adventure,
    baseline,
    mergeResult: null,
    coreImportCompleted: false,
    created: null,
    updated: null
  };

  let importError = null;

  try {
    await adventure.import(options ?? {});
  } catch (error) {
    importError = error;
  } finally {
    const context = bypassContext;
    const mergeResult = context?.mergeResult ?? emptyMergeStats();
    const coreImportCompleted = Boolean(context?.coreImportCompleted);
    bypassContext = null;

    if (coreImportCompleted) {
      const newBaseline = buildBaselineFromAdventureSource(adventure.toObject(), {
        source: "post-import",
        adventureId: adventure.id ?? null,
        adventureName: adventure.name ?? null,
        capturedAt: new Date().toISOString()
      });

      try {
        await saveBaseline(adventure, newBaseline);
      } catch (error) {
        console.error(`${MODULE_TITLE} | Falha ao salvar nova baseline`, error);
        downloadBaselineFile(adventure, newBaseline);
        ui.notifications.warn(`${MODULE_TITLE}: não consegui salvar a nova baseline no mundo; baixei uma cópia para você.`);
      }

      showImportResult(mergeResult);

      if (importError) {
        console.error(`${MODULE_TITLE} | A Adventure foi importada, mas uma rotina pós-importação falhou`, importError);
        ui.notifications.warn(
          `${MODULE_TITLE}: o conteúdo da Adventure foi importado e as traduções foram protegidas, mas uma rotina pós-importação do módulo da Adventure falhou. Não importe novamente.`,
          { permanent: true }
        );
      }
    } else if (importError) {
      throw importError;
    }
  }
}

async function requestBaselineFile(adventure) {
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: "Baseline necessária" },
    content: `
      <div class="rtk-dialog">
        <p><strong>Esta é a primeira atualização protegida desta Adventure.</strong></p>
        <p>Para saber o que é tradução e o que realmente mudou no Ember, selecione o backup antigo da tradução que você já criou.</p>
        <input type="file" name="baselineFile" accept=".json,application/json">
        <p class="rtk-help">Aceita o <code>EMBER-TRADUCAO-BACKUP...</code> ou um backup anterior do Translation Keeper.</p>
      </div>
    `,
    modal: true,
    rejectClose: false,
    buttons: [
      {
        action: "load",
        label: "Carregar backup antigo",
        icon: "fa-solid fa-file-import",
        default: true,
        callback: async (_event, _button, dialog) => {
          const input = dialog.element.querySelector('input[name="baselineFile"]');
          const file = input?.files?.[0];
          if (!file) return { error: "Selecione um arquivo JSON." };

          try {
            const data = JSON.parse(await file.text());
            return { data, filename: file.name };
          } catch (error) {
            return { error: `JSON inválido: ${error.message}` };
          }
        }
      },
      {
        action: "cancel",
        label: "Cancelar",
        icon: "fa-solid fa-ban",
        callback: () => null
      }
    ]
  });

  if (!result) return null;
  if (result.error) {
    ui.notifications.error(`${MODULE_TITLE}: ${result.error}`);
    return null;
  }

  try {
    const baseline = importBaselineFromObject(result.data, adventure);
    ui.notifications.info(`${MODULE_TITLE}: baseline carregada de ${result.filename}.`);
    return baseline;
  } catch (error) {
    console.error(`${MODULE_TITLE} | Backup incompatível`, error);
    ui.notifications.error(`${MODULE_TITLE}: ${error.message}`);
    return null;
  }
}

function importBaselineFromObject(data, adventure) {
  if (!data || typeof data !== "object") throw new Error("Arquivo de backup vazio ou inválido.");

  if (data.backupType === "RPG_UP_TRANSLATION_KEEPER_BASELINE" && data.baseline) {
    return validateBaseline(data.baseline, adventure);
  }

  if (data.backupType === "EMBER_TRANSLATION_BACKUP" && Array.isArray(data.emberAdventureBaseline)) {
    const entries = data.emberAdventureBaseline;
    const match = entries.find(entry => entry?.id === adventure?.id)
      ?? entries.find(entry => entry?.name === adventure?.name)
      ?? (entries.length === 1 ? entries[0] : null);

    if (!match?.data) throw new Error("Não encontrei esta Adventure dentro do backup antigo.");

    return buildBaselineFromAdventureSource(match.data, {
      source: "ember-translation-backup",
      adventureId: match.id ?? adventure?.id ?? null,
      adventureName: match.name ?? adventure?.name ?? null,
      capturedAt: data.createdAt ?? null
    });
  }

  if (data.backupType === "RPG_UP_TRANSLATION_KEEPER_ADVENTURE_IMPORT" && data.adventure?.incomingSource) {
    return buildBaselineFromAdventureSource(data.adventure.incomingSource, {
      source: "translation-keeper-backup",
      adventureId: data.adventure.id ?? adventure?.id ?? null,
      adventureName: data.adventure.name ?? adventure?.name ?? null,
      capturedAt: data.createdAt ?? null
    });
  }

  if (data.actors || data.items || data.journal || data.scenes || data.tables) {
    return buildBaselineFromAdventureSource(data, {
      source: "raw-adventure-json",
      adventureId: data._id ?? adventure?.id ?? null,
      adventureName: data.name ?? adventure?.name ?? null,
      capturedAt: new Date().toISOString()
    });
  }

  throw new Error("Esse JSON não contém uma baseline de Adventure reconhecida.");
}

function validateBaseline(baseline, adventure) {
  if (baseline.schemaVersion !== BASELINE_SCHEMA_VERSION || !baseline.documents) {
    throw new Error("Formato de baseline incompatível.");
  }

  const expectedId = adventure?.id ?? null;
  const storedId = baseline.meta?.adventureId ?? null;
  if (expectedId && storedId && expectedId !== storedId) {
    throw new Error(`A baseline pertence à Adventure ${storedId}, não ${expectedId}.`);
  }

  return baseline;
}

function buildBaselineFromAdventureSource(source, meta = {}) {
  const baseline = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    meta: {
      ...meta,
      adventureId: meta.adventureId ?? source?._id ?? null,
      adventureName: meta.adventureName ?? source?.name ?? null,
      createdAt: new Date().toISOString()
    },
    documents: {}
  };

  for (const [field, documentName] of Object.entries(ADVENTURE_FIELDS)) {
    const entries = normalizeAdventureCollection(source?.[field]);
    if (!entries.length) continue;

    const docs = {};
    for (const doc of entries) {
      const id = doc?._id ?? doc?.id;
      if (!id) continue;
      docs[id] = {
        name: doc?.name ?? null,
        strings: collectStringLeaves(doc)
      };
    }
    if (Object.keys(docs).length) baseline.documents[documentName] = docs;
  }

  return baseline;
}

function normalizeAdventureCollection(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return [...value.values()];
  if (typeof value === "object") return Object.values(value);
  return [];
}

function collectStringLeaves(root) {
  const result = {};

  const walk = (value, tokens) => {
    if (typeof value === "string") {
      result[JSON.stringify(tokens)] = value;
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        const token = entry && typeof entry === "object" && (entry._id ?? entry.id)
          ? { id: entry._id ?? entry.id }
          : { index };
        walk(entry, [...tokens, token]);
      });
      return;
    }

    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) walk(entry, [...tokens, key]);
  };

  walk(root, []);
  return result;
}

function indexStringLeaves(root, referenceRoot = null) {
  const result = new Map();

  const getEntryId = entry => entry && typeof entry === "object"
    ? (entry._id ?? entry.id ?? null)
    : null;

  const walk = (value, tokens, parent, key, referenceValue) => {
    if (typeof value === "string") {
      result.set(JSON.stringify(tokens), {
        value,
        set(next) {
          parent[key] = next;
          this.value = next;
        }
      });
      return;
    }

    if (Array.isArray(value)) {
      const referenceArray = Array.isArray(referenceValue) ? referenceValue : null;

      value.forEach((entry, index) => {
        const ownId = getEntryId(entry);
        let referenceEntry = referenceArray?.[index] ?? null;

        // Prefer an exact stable-ID match when both sides still have IDs.
        if (ownId && referenceArray) {
          referenceEntry = referenceArray.find(candidate => getEntryId(candidate) === ownId)
            ?? referenceEntry;
        }

        const referenceId = getEntryId(referenceEntry);

        // Some translation tools rebuild array entries and accidentally remove
        // technical IDs (Ember quest outcomes are a real example). When that
        // happens, borrow the incoming Adventure's ID for the same array slot
        // so the translated local entry can still match the baseline safely.
        const token = referenceId
          ? { id: referenceId }
          : ownId
            ? { id: ownId }
            : { index };

        walk(entry, [...tokens, token], value, index, referenceEntry);
      });
      return;
    }

    if (!value || typeof value !== "object") return;

    const referenceObject = referenceValue && typeof referenceValue === "object" && !Array.isArray(referenceValue)
      ? referenceValue
      : null;

    for (const [childKey, entry] of Object.entries(value)) {
      walk(
        entry,
        [...tokens, childKey],
        value,
        childKey,
        referenceObject?.[childKey]
      );
    }
  };

  walk(root, [], { root }, "root", referenceRoot);
  return result;
}

function applyTranslationMerge(adventure, toUpdate = {}, baseline) {
  return runTranslationMerge(toUpdate, baseline, true);
}

function previewTranslationMerge(toUpdate = {}, baseline) {
  const clone = safeClone(toUpdate);
  return runTranslationMerge(clone, baseline, false);
}

function runTranslationMerge(toUpdate = {}, baseline, mutate) {
  const stats = emptyMergeStats();

  for (const [documentName, incomingDocs] of Object.entries(toUpdate ?? {})) {
    const baseDocs = baseline?.documents?.[documentName];
    if (!baseDocs || !Array.isArray(incomingDocs)) continue;

    const collection = game.collections.get(documentName);

    for (const incoming of incomingDocs) {
      const id = incoming?._id ?? incoming?.id;
      if (!id) continue;

      const oldDoc = baseDocs[id];
      const current = collection?.get(id);
      if (!oldDoc || !current) {
        stats.documentsWithoutBaseline += 1;
        continue;
      }

      stats.documentsCompared += 1;
      const localObject = current.toObject();
      const localStrings = indexStringLeaves(localObject, incoming);
      const newStrings = indexStringLeaves(incoming);

      for (const [path, oldValue] of Object.entries(oldDoc.strings ?? {})) {
        const localNode = localStrings.get(path);
        const newNode = newStrings.get(path);
        if (!localNode || !newNode) continue;

        const localValue = localNode.value;
        const newValue = newNode.value;

        if (localValue === oldValue) continue;

        if (!isTranslatablePath(documentName, path)) {
          stats.ignoredTechnicalDifferences += 1;
          continue;
        }

        stats.localDifferences += 1;

        if (newValue === oldValue) {
          stats.safePreservedFields += 1;
          if (mutate) newNode.set(localValue);
          continue;
        }

        stats.sourceChangedFields += 1;
        stats.needsRetranslation += 1;

        const htmlMerge = mergeHtmlTextNodes(oldValue, localValue, newValue);
        if (htmlMerge.changed) {
          stats.htmlFieldsMerged += 1;
          stats.htmlTextNodesPreserved += htmlMerge.preservedNodes;
          if (mutate) newNode.set(htmlMerge.value);
        }
      }
    }
  }

  return stats;
}

function isTranslatablePath(documentName, path) {
  let tokens;
  try {
    tokens = JSON.parse(path);
  } catch {
    return false;
  }

  const keys = tokens
    .filter(token => typeof token === "string")
    .map(key => key.toLowerCase());

  if (!keys.length) return false;

  const blockedContainers = new Set([
    "_stats",
    "flags",
    "ownership",
    "permission",
    "permissions",
    "texture",
    "prototypetoken",
    "prototype-token"
  ]);

  if (keys.some(key => blockedContainers.has(key))) return false;

  const last = keys.at(-1);
  const parent = keys.at(-2) ?? "";

  const directTextFields = new Set([
    "name",
    "description",
    "content",
    "caption",
    "label",
    "flavor",
    "chatflavor",
    "summary",
    "biography",
    "appearance",
    "notes",
    "public",
    "private",
    "race",
    "alignment",
    "background",
    "faith",
    "gender",
    "eyes",
    "hair",
    "skin",
    "bond",
    "ideal",
    "flaw",
    "trait",
    "personality",
    "text",
    // Ember Adventure custom narrative fields.
    "overview",
    "exposition",
    "gamemaster"
  ]);

  if (directTextFields.has(last)) return true;

  if (last === "value") {
    const semanticValueParents = new Set([
      "description",
      "biography",
      "appearance",
      "notes",
      "public",
      "private",
      "text",
      "flavor",
      "chatflavor",
      "summary"
    ]);
    if (semanticValueParents.has(parent)) return true;
  }

  // D&D5e stores alternate chat-card prose under system.description.chat.
  if (last === "chat" && parent === "description") return true;

  // Macros contain executable source in "command"; never treat it as translation text.
  if (documentName === "Macro") return last === "name";

  return false;
}

function mergeHtmlTextNodes(baseHtml, localHtml, incomingHtml) {
  if (![baseHtml, localHtml, incomingHtml].every(value => typeof value === "string")) {
    return { changed: false, value: incomingHtml, preservedNodes: 0 };
  }

  if (!looksLikeHtml(baseHtml) || !looksLikeHtml(localHtml) || !looksLikeHtml(incomingHtml)) {
    return { changed: false, value: incomingHtml, preservedNodes: 0 };
  }

  try {
    const base = document.createElement("template");
    const local = document.createElement("template");
    const incoming = document.createElement("template");
    base.innerHTML = baseHtml;
    local.innerHTML = localHtml;
    incoming.innerHTML = incomingHtml;

    const baseNodes = indexTextNodes(base.content);
    const localNodes = indexTextNodes(local.content);
    const incomingNodes = indexTextNodes(incoming.content);
    let preservedNodes = 0;

    for (const [path, baseNode] of baseNodes) {
      const localNode = localNodes.get(path);
      const incomingNode = incomingNodes.get(path);
      if (!localNode || !incomingNode) continue;

      const baseText = baseNode.nodeValue ?? "";
      const localText = localNode.nodeValue ?? "";
      const incomingText = incomingNode.nodeValue ?? "";

      if (localText === baseText) continue;
      if (incomingText !== baseText) continue;

      incomingNode.nodeValue = localText;
      preservedNodes += 1;
    }

    return {
      changed: preservedNodes > 0,
      value: incoming.innerHTML,
      preservedNodes
    };
  } catch (error) {
    console.warn(`${MODULE_TITLE} | Falha no merge HTML seguro`, error);
    return { changed: false, value: incomingHtml, preservedNodes: 0 };
  }
}

function indexTextNodes(root) {
  const result = new Map();

  const walk = (node, path) => {
    if (node.nodeType === Node.TEXT_NODE) {
      result.set(path.join("/"), node);
      return;
    }

    [...node.childNodes].forEach((child, index) => walk(child, [...path, index]));
  };

  walk(root, []);
  return result;
}

function looksLikeHtml(value) {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function emptyMergeStats() {
  return {
    documentsCompared: 0,
    documentsWithoutBaseline: 0,
    localDifferences: 0,
    ignoredTechnicalDifferences: 0,
    safePreservedFields: 0,
    sourceChangedFields: 0,
    htmlFieldsMerged: 0,
    htmlTextNodesPreserved: 0,
    needsRetranslation: 0
  };
}

function analyzeImport(toCreate = {}, toUpdate = {}) {
  const types = [...new Set([...Object.keys(toCreate ?? {}), ...Object.keys(toUpdate ?? {})])].sort();
  const byType = {};
  let totalCreate = 0;
  let totalUpdate = 0;

  for (const type of types) {
    const create = Array.isArray(toCreate?.[type]) ? toCreate[type].length : 0;
    const update = Array.isArray(toUpdate?.[type]) ? toUpdate[type].length : 0;
    byType[type] = { create, update };
    totalCreate += create;
    totalUpdate += update;
  }

  return { byType, totalCreate, totalUpdate, overwriteRisk: totalUpdate };
}

function buildBackupPayload(adventure, toCreate = {}, toUpdate = {}, analysis = analyzeImport(toCreate, toUpdate), mergePreview = emptyMergeStats(), baseline = null) {
  const currentWorldDocuments = {};
  const missingWorldDocuments = {};

  for (const [documentName, incomingDocuments] of Object.entries(toUpdate ?? {})) {
    currentWorldDocuments[documentName] = [];
    missingWorldDocuments[documentName] = [];

    const collection = game.collections.get(documentName);

    for (const incoming of incomingDocuments ?? []) {
      const id = incoming?._id ?? incoming?.id ?? null;
      const current = id ? collection?.get(id) : null;

      if (current) {
        currentWorldDocuments[documentName].push({
          id: current.id,
          name: current.name ?? null,
          uuid: current.uuid ?? null,
          data: current.toObject()
        });
      } else {
        missingWorldDocuments[documentName].push({ id, name: incoming?.name ?? null });
      }
    }
  }

  return {
    backupType: "RPG_UP_TRANSLATION_KEEPER_ADVENTURE_IMPORT",
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    keeper: {
      id: MODULE_ID,
      version: game.modules.get(MODULE_ID)?.version ?? null
    },
    environment: {
      foundry: game.version,
      worldId: game.world?.id ?? null,
      worldTitle: game.world?.title ?? null,
      systemId: game.system?.id ?? null,
      systemVersion: game.system?.version ?? null
    },
    adventure: {
      id: adventure.id ?? null,
      name: adventure.name ?? null,
      uuid: adventure.uuid ?? null,
      pack: adventure.pack ?? adventure.collection?.collection ?? null,
      incomingSource: adventure.toObject()
    },
    summary: analysis,
    mergePreview,
    baselineUsed: baseline ? {
      schemaVersion: baseline.schemaVersion,
      meta: baseline.meta
    } : null,
    currentWorldDocuments,
    missingWorldDocuments,
    incoming: {
      toCreate: safeClone(toCreate),
      toUpdate: safeClone(toUpdate)
    },
    translateAll: getSafeTranslateAllBackup()
  };
}

function downloadBackup(payload, adventure) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const adventureSlug = slugify(adventure?.name || adventure?.id || "adventure");
  const filename = `TRANSLATION-KEEPER-${adventureSlug}-${stamp}.json`;

  foundry.utils.saveDataToFile(JSON.stringify(payload, null, 2), "application/json", filename);
  ui.notifications.info(`${MODULE_TITLE}: backup solicitado para download.`);
  console.log(`${MODULE_TITLE} | Backup criado`, { filename, summary: payload.summary, mergePreview: payload.mergePreview });
  return filename;
}

function downloadBaselineFile(adventure, baseline) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const adventureSlug = slugify(adventure?.name || adventure?.id || "adventure");
  const filename = `TRANSLATION-KEEPER-BASELINE-${adventureSlug}-${stamp}.json`;
  const payload = {
    backupType: "RPG_UP_TRANSLATION_KEEPER_BASELINE",
    schemaVersion: BASELINE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    baseline
  };
  foundry.utils.saveDataToFile(JSON.stringify(payload, null, 2), "application/json", filename);
  return filename;
}

function getSafeTranslateAllBackup() {
  const namespace = "translate-all";
  const wantedKeys = ["targetSystem", "targetLanguage", "outputMode", "cacheEnabled", "translationCache"];
  const result = {};

  for (const key of wantedKeys) {
    const fullKey = `${namespace}.${key}`;
    if (!game.settings.settings.has(fullKey)) continue;

    try {
      let value = game.settings.get(namespace, key);
      if (key === "translationCache" && typeof value === "string") {
        try { value = JSON.parse(value); } catch { /* mantém string original */ }
      }
      result[key] = safeClone(value);
    } catch (error) {
      console.warn(`${MODULE_TITLE} | Não foi possível ler ${fullKey}`, error);
    }
  }

  return Object.keys(result).length ? result : null;
}

function buildAnalysisHtml(adventure, analysis, preview, hasBaseline) {
  const rows = Object.entries(analysis.byType)
    .map(([type, counts]) => `
      <tr>
        <td>${escapeHtml(type)}</td>
        <td>${counts.create}</td>
        <td><strong>${counts.update}</strong></td>
      </tr>
    `)
    .join("");

  const baselineText = hasBaseline
    ? `<span class="rtk-good">✓ Baseline antiga encontrada.</span>`
    : `<span class="rtk-warn">⚠ Sem baseline antiga.</span>`;

  return `
    <div class="rtk-dialog">
      <p>Você tentou importar <strong>${escapeHtml(adventure?.name ?? "Adventure")}</strong>.</p>
      <p>${baselineText}</p>
      <table class="rtk-table">
        <thead><tr><th>Tipo</th><th>Novos</th><th>Atualizados</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3">Sem alterações detectadas.</td></tr>'}</tbody>
      </table>
      ${hasBaseline ? `
        <div class="rtk-summary">
          <strong>Prévia da proteção:</strong>
          <span>${preview.safePreservedFields} campos traduzidos podem ser preservados com segurança.</span>
          <span>${preview.htmlTextNodesPreserved} trechos HTML inalterados podem ser mantidos.</span>
          <span>${preview.needsRetranslation} campo(s) de texto mudaram no original e precisarão de nova tradução.</span>
          <span>${preview.ignoredTechnicalDifferences} diferenças técnicas/migração foram ignoradas.</span>
        </div>
      ` : ""}
      <p>Antes de importar, o Translation Keeper baixa uma cópia dos documentos atuais e dos dados novos.</p>
      <p><strong>Nenhuma API key do Translate All é incluída.</strong></p>
    </div>
  `;
}

function buildBackupConfirmationHtml(filename, preview, hasBaseline) {
  return `
    <div class="rtk-confirm">
      <p><strong>Confira se o arquivo apareceu nos downloads do navegador.</strong></p>
      <p class="rtk-filename"><code>${escapeHtml(filename)}</code></p>
      ${hasBaseline ? `
        <div class="rtk-summary">
          <span>✓ ${preview.safePreservedFields} campo(s) locais preserváveis.</span>
          <span>✓ ${preview.htmlTextNodesPreserved} trecho(s) HTML preserváveis.</span>
          <span>⚠ ${preview.needsRetranslation} campo(s) de texto com mudança real no original.</span>
          <span>↪ ${preview.ignoredTechnicalDifferences} diferença(s) técnicas ignoradas.</span>
        </div>
        <p>Ao continuar, o merge é aplicado <strong>antes</strong> do Foundry sobrescrever os documentos.</p>
      ` : ""}
    </div>
  `;
}

function showImportResult(result) {
  const message = result.localDifferences > 0
    ? `${MODULE_TITLE}: importação concluída. ${result.safePreservedFields} campo(s) e ${result.htmlTextNodesPreserved} trecho(s) HTML foram preservados; ${result.needsRetranslation} campo(s) de texto mudaram no original; ${result.ignoredTechnicalDifferences} diferenças técnicas foram ignoradas.`
    : `${MODULE_TITLE}: importação concluída; nenhuma tradução local precisou ser restaurada.`;

  ui.notifications.info(message, { permanent: result.needsRetranslation > 0 });
  console.log(`${MODULE_TITLE} | Resultado final`, result);
}

function getAdventureKey(adventure) {
  const pack = adventure?.pack ?? adventure?.collection?.collection ?? "unknown-pack";
  const id = adventure?.id ?? adventure?._id ?? adventure?.name ?? "unknown-adventure";
  return `${pack}::${id}`;
}

function sameAdventure(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return getAdventureKey(a) === getAdventureKey(b);
}

function getStoredBaseline(adventure) {
  const baselines = game.settings.get(MODULE_ID, "baselines") ?? {};
  const direct = baselines[getAdventureKey(adventure)];
  if (direct) return direct;

  const id = adventure?.id ?? null;
  if (!id) return null;
  return Object.values(baselines).find(entry => entry?.meta?.adventureId === id) ?? null;
}

async function saveBaseline(adventure, baseline) {
  const baselines = safeClone(game.settings.get(MODULE_ID, "baselines") ?? {});
  baselines[getAdventureKey(adventure)] = baseline;
  await game.settings.set(MODULE_ID, "baselines", baselines);
}

function getBaselineStatus(adventure) {
  const baseline = getStoredBaseline(adventure);
  return {
    found: Boolean(baseline),
    key: getAdventureKey(adventure),
    meta: baseline?.meta ?? null,
    documentTypes: baseline ? Object.fromEntries(
      Object.entries(baseline.documents ?? {}).map(([type, docs]) => [type, Object.keys(docs).length])
    ) : {}
  };
}

function safeClone(value) {
  try { return foundry.utils.deepClone(value); }
  catch {
    try { return structuredClone(value); }
    catch { return JSON.parse(JSON.stringify(value)); }
  }
}

function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "adventure";
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}
