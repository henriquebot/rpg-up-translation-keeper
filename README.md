# RPG Up Translation Keeper

Módulo para Foundry VTT v14 que reduz o risco de perder traduções ao reimportar Adventures.

## O que a v0.1.0 faz

Ao clicar em **Import Adventure**, o módulo interrompe a importação antes que o Foundry sobrescreva documentos do mundo.

Ele mostra quantos documentos serão criados e atualizados e, se o GM continuar, gera um arquivo JSON com:

- cópia completa dos documentos atuais que seriam sobrescritos;
- dados novos que a Adventure pretende criar/atualizar;
- fonte da Adventure que está entrando;
- metadados de Foundry, mundo e sistema;
- cache e preferências seguras do **Translate All**, quando o módulo estiver instalado.

O backup **não inclui API keys** do Translate All.

Depois do download, uma segunda confirmação é exigida. Só então o Translation Keeper relança a importação e libera aquela tentativa específica.

## Escopo atual

A v0.1.0 é uma camada anti-acidente e de backup. Ela ainda **não faz merge automático de traduções**.

O objetivo das próximas versões é comparar:

1. Adventure original anterior;
2. documentos traduzidos do mundo;
3. Adventure atualizada;

para restaurar automaticamente apenas traduções cujo conteúdo original não mudou e separar o conteúdo alterado para retradução.

## Configuração

Em **Configurações do módulo**, o GM pode ativar ou desativar `Proteger importação de Adventures`.

A proteção vale para qualquer Adventure importada no mundo, não apenas Ember.

## Compatibilidade

- Foundry VTT 14+
- Verificado inicialmente em Foundry 14.368

## Desenvolvimento

ID do módulo: `rpg-up-translation-keeper`

Repositório: https://github.com/henriquebot/rpg-up-translation-keeper
