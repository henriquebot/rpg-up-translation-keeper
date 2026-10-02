# Changelog

## 0.2.1

- Restringe o merge automático a campos realmente traduzíveis.
- Ignora diferenças técnicas de D&D5e/Foundry, como migração, flags e metadados.
- A prévia agora mostra separadamente quantas diferenças técnicas foram ignoradas.
- Mantém a proteção de três vias para nomes, descrições, journals, textos de tabelas e outros campos de leitura.

## 0.2.0

- Adiciona merge de três vias para preservar traduções durante Adventure Import.
- Adiciona baseline persistente por Adventure.
- Aceita o backup manual `EMBER-TRADUCAO-BACKUP` como baseline inicial.
- Preserva campos locais quando o original não mudou.
- Faz merge seguro por nós de texto em campos HTML parcialmente alterados.
- Bloqueia a primeira atualização protegida quando não há baseline antiga.
- Salva automaticamente a nova baseline após importação bem-sucedida.
- Exibe prévia com campos preserváveis e campos que precisarão retradução.
- Mantém backup automático antes da importação e nunca inclui API keys.

## 0.1.0

- Intercepta `preImportAdventure` antes de qualquer sobrescrita.
- Mostra resumo de documentos novos e atualizados.
- Exporta backup JSON dos documentos atuais afetados.
- Inclui os dados de entrada da Adventure para auditoria futura.
- Inclui cache seguro do Translate All quando disponível, sem API keys.
- Exige confirmação após o backup antes de relançar a importação.
