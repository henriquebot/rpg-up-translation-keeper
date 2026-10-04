# RPG Up Translation Keeper

Proteção de traduções para atualizações de **Adventures** no Foundry VTT v14.

## O que a v0.2.4 faz

Quando o GM tenta usar **Import Adventure**, o módulo interrompe a operação antes da sobrescrita e executa um fluxo seguro:

1. identifica os documentos que serão criados e atualizados;
2. exige uma **baseline antiga** da Adventure para o primeiro merge protegido;
3. gera um backup JSON dos documentos atuais e dos dados novos;
4. compara **original antigo → mundo local traduzido → original novo**;
5. preserva automaticamente campos locais cujo original não mudou;
6. em HTML, preserva também nós de texto individuais quando apenas parte do conteúdo mudou;
7. deixa em inglês apenas campos/trechos que realmente mudaram no original;
8. depois de uma importação bem-sucedida, salva a nova baseline para a próxima atualização;
9. sincroniza automaticamente os **Outcomes narrativos do Ember** com os Journals já traduzidos após recarregar o Foundry ou atualizar uma página, preservando traduções locais e ignorando mapeamentos ambíguos.

## Primeira atualização protegida

Na primeira vez, o módulo pede um backup anterior contendo a Adventure antiga. Ele aceita:

- `EMBER-TRADUCAO-BACKUP-....json` criado pelo fluxo anterior do projeto;
- backups anteriores do próprio Translation Keeper;
- uma baseline exportada pelo Translation Keeper.

Depois disso, a baseline passa a ser armazenada no mundo automaticamente.

## Segurança

- O hook `preImportAdventure` bloqueia a importação original antes de qualquer sobrescrita.
- A importação só é relançada depois do backup e de uma confirmação explícita do GM.
- O merge é aplicado aos dados de `toUpdate` **antes** do Foundry gravá-los no mundo.
- Campos que mudaram no original não recebem tradução antiga cegamente.
- O backup inclui o cache seguro do Translate All quando disponível, mas **não inclui API keys**.

## Limite intencional

Se o texto original mudou de verdade, o módulo não inventa uma tradução nova. Ele preserva o que ainda é seguro e informa quantos campos precisam ser retraduzidos.

## Compatibilidade

- Foundry VTT 14+
- Verificado inicialmente em Foundry 14.368

Manifest:

`https://raw.githubusercontent.com/henriquebot/rpg-up-translation-keeper/main/module.json`
