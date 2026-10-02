const MODULE_ID = "rpg-up-translation-keeper";
const MODULE_TITLE = "RPG Up Translation Keeper";
const BACKUP_SCHEMA_VERSION = 1;

let bypassAdventure = null;
let protectionFlowRunning = false;

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "Proteger importação de Adventures",
    hint: "Intercepta a importação de Adventures, gera um backup dos documentos que seriam sobrescritos e pede confirmação antes de continuar.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    restricted: true
  });

  game.settings.register(MODULE_ID, "lastBackup", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
    restricted: true
  });
});

Hooks.once("ready", () => {
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      analyzeImport,
      buildBackupPayload,
      downloadBackup
    };
  }

  if (game.user?.isGM) {
    console.log(`${MODULE_TITLE} | Proteção de Adventure Import ativa.`);
  }
});

Hooks.on("preImportAdventure", (adventure, options, toCreate, toUpdate) => {
  if (!game.user?.isGM) return;
  if (!game.settings.get(MODULE_ID, "enabled")) return;

  // A única importação que passa sem nova verificação é a que o próprio
  // Translation Keeper relança imediatamente após o backup confirmado.
  if (bypassAdventure === adventure) return true;

  if (protectionFlowRunning) {
    ui.notifications.warn(`${MODULE_TITLE}: já existe uma verificação de importação em andamento.`);
    return false;
  }

  protectionFlowRunning = true;

  // preImportAdventure é síncrono. A importação precisa ser bloqueada agora;
  // a interface de confirmação é aberta logo em seguida, de forma assíncrona.
  setTimeout(async () => {
    try {
      await runProtectionFlow(adventure, options, toCreate, toUpdate);
    } catch (error) {
      console.error(`${MODULE_TITLE} | Falha no fluxo de proteção`, error);
      ui.notifications.error(`${MODULE_TITLE}: não foi possível preparar a importação. Nada foi importado.`);
    } finally {
      protectionFlowRunning = false;
    }
  }, 0);

  return false;
});

async function runProtectionFlow(adventure, options, toCreate, toUpdate) {
  const analysis = analyzeImport(toCreate, toUpdate);
  const DialogV2 = foundry.applications.api.DialogV2;

  const wantsBackup = await DialogV2.confirm({
    window: { title: `🛡️ ${MODULE_TITLE}` },
    content: buildAnalysisHtml(adventure, analysis),
    modal: true,
    rejectClose: false,
    yes: {
      label: "Gerar backup de segurança",
      icon: "fa-solid fa-download",
      callback: () => true
    },
    no: {
      label: "Cancelar importação",
      icon: "fa-solid fa-ban",
      callback: () => false
    }
  });

  if (!wantsBackup) {
    ui.notifications.info(`${MODULE_TITLE}: importação cancelada. Nenhum documento foi alterado.`);
    return;
  }

  const payload = buildBackupPayload(adventure, toCreate, toUpdate, analysis);
  const filename = downloadBackup(payload, adventure);

  await game.settings.set(MODULE_ID, "lastBackup", {
    createdAt: payload.createdAt,
    filename,
    adventureId: payload.adventure.id,
    adventureName: payload.adventure.name,
    createCount: analysis.totalCreate,
    updateCount: analysis.totalUpdate
  });

  const proceed = await DialogV2.confirm({
    window: { title: "Backup solicitado" },
    content: `
      <div class="rtk-confirm">
        <p><strong>Confira se o arquivo apareceu nos downloads do navegador.</strong></p>
        <p class="rtk-filename"><code>${escapeHtml(filename)}</code></p>
        <p>A importação continua apenas se você confirmar abaixo.</p>
      </div>
    `,
    modal: true,
    rejectClose: false,
    yes: {
      label: "Backup OK — importar Adventure",
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

  bypassAdventure = adventure;
  try {
    await adventure.import(options ?? {});
  } finally {
    bypassAdventure = null;
  }
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

  return {
    byType,
    totalCreate,
    totalUpdate,
    overwriteRisk: totalUpdate
  };
}

function buildBackupPayload(adventure, toCreate = {}, toUpdate = {}, analysis = analyzeImport(toCreate, toUpdate)) {
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
        missingWorldDocuments[documentName].push({
          id,
          name: incoming?.name ?? null
        });
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

  foundry.utils.saveDataToFile(
    JSON.stringify(payload, null, 2),
    "application/json",
    filename
  );

  ui.notifications.info(`${MODULE_TITLE}: backup solicitado para download.`);
  console.log(`${MODULE_TITLE} | Backup criado`, { filename, summary: payload.summary });
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
        try {
          value = JSON.parse(value);
        } catch {
          // Mantém o valor original se não for JSON válido.
        }
      }
      result[key] = safeClone(value);
    } catch (error) {
      console.warn(`${MODULE_TITLE} | Não foi possível ler ${fullKey}`, error);
    }
  }

  return Object.keys(result).length ? result : null;
}

function buildAnalysisHtml(adventure, analysis) {
  const rows = Object.entries(analysis.byType)
    .map(([type, counts]) => `
      <tr>
        <td>${escapeHtml(type)}</td>
        <td>${counts.create}</td>
        <td><strong>${counts.update}</strong></td>
      </tr>
    `)
    .join("");

  const riskText = analysis.totalUpdate > 0
    ? `<strong>${analysis.totalUpdate}</strong> documento(s) existente(s) podem ser sobrescritos.`
    : "Nenhum documento existente será sobrescrito nesta importação.";

  return `
    <div class="rtk-dialog">
      <p>Você tentou importar <strong>${escapeHtml(adventure?.name ?? "Adventure")}</strong>.</p>
      <p class="rtk-risk">${riskText}</p>
      <table class="rtk-table">
        <thead>
          <tr><th>Tipo</th><th>Novos</th><th>Atualizados</th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="3">Sem alterações detectadas.</td></tr>'}</tbody>
      </table>
      <p>O Translation Keeper vai baixar um JSON contendo os documentos atuais que seriam substituídos, os dados que estão entrando e o cache seguro do Translate All quando disponível.</p>
      <p><strong>Nenhuma API key do Translate All é incluída.</strong></p>
    </div>
  `;
}

function safeClone(value) {
  try {
    return foundry.utils.deepClone(value);
  } catch {
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value));
    }
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
