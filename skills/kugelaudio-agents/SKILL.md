---
name: kugelaudio-agents
description: Build a KugelAudio voice agent with the Curb framework, from an empty folder to a deployed agent. Scaffold it with create-curb-app, verify it with curb check and curb say, try it in curb dev, deploy it to KugelAudio and read its logs, and look up every KugelAudio fact in the docs through the KugelAudio MCP server. Use when someone wants a voice agent, voice bot, phone agent or hotline on KugelAudio, mentions Curb, curb.js or create-curb-app, or asks to deploy or debug a hosted KugelAudio agent. For KugelAudio text to speech inside an existing app, use kugelaudio-tts.
---

# KugelAudio voice agents

A KugelAudio voice agent is a Curb project: React components describe what the model
sees (its prompt, skills and tools) and the framework runs the call (speech in and out,
turn-taking, interruptions). This skill gets you from an empty folder to an agent
someone can call. Once the project exists, its `AGENTS.md` is the reference; read it
before you change anything.

## Look facts up, never recall them

Model ids, voices, limits, prices and APIs change. Before you write one down:

- KugelAudio MCP connected: `search_docs`, then `read_docs_page` on a result. On the
  `kugelaudio` server they include the pages of models released only to your organization.
- No MCP: https://docs.kugelaudio.com/llms.txt lists every page; a page's URL plus `.md`
  is its Markdown.
- The framework: `node_modules/curb/docs/agent-guide/` in the project, `README.md` first.
  It matches the Curb version the project runs.

## 1. Create the project

Node.js 22.12 or newer. Ask what the agent is for and which language its callers speak,
then scaffold it into a new folder with a lowercase name such as `pizza-agent` (it
refuses a folder that is not empty):

    npx --yes --allow-remote=all https://cdn.kugelaudio.com/curb/create-curb-app.tgz <folder> --yes

The trailing `--yes` skips the setup wizard, which is meant for a person at a terminal:
it takes the default providers and reads their keys from the environment. `--stt`,
`--llm` and `--tts` pick other providers; `--help` lists every flag. Never write a Curb
project by hand or copy one from an example. Then `cd <folder>` and read `AGENTS.md`.

## 2. Make it the user's agent

The project starts as Juno, a demo assistant. Replace its prompt, skills and tools with
the user's agent and delete what it does not need, following `AGENTS.md`.

## 3. Verify every change

    npx curb check                        # types, renders every skill; each warning names its fix
    npx curb say "<what a caller says>"   # one turn in the terminal; --new starts over
    npx curb test                         # the conversations in src/**/*.scenario.ts
    npm run dev                           # curb dev: chat and voice in the browser preview

Hand nothing over while `curb check` reports an error or a warning. `curb test` fails
until the project has a scenario: add one for every flow that matters (`testing.md` in
the agent guide). `npm run dev` keeps running, so start it in the background and give
the user the link it prints. Text needs only the language model's key; voice also needs
`KUGELAUDIO_API_KEY`.

## 4. Keys

`.env` holds the keys (`ANTHROPIC_API_KEY` and `KUGELAUDIO_API_KEY` with the default
providers). A KugelAudio key comes from API Keys in the dashboard at
https://kugelaudio.com/dashboard; someone without an account signs up at
https://kugelaudio.com first. Ask the user for the values; never print them and never
commit `.env`.

## 5. Deploy

The project's `.mcp.json` registers two MCP servers for Claude Code started in the
project folder, which asks once to use them: `kugelaudio`, the user's account (the user
runs `/mcp`, chooses `kugelaudio`, signs in, picks the project and presses Allow), and
`kugelaudio-docs`, the docs (no sign-in). A session started in another folder does not
see them: ask the user to restart Claude Code in the project, or use the CLI.
Sign-in trouble: https://docs.kugelaudio.com/hosted-agents/coding-agent

- MCP: `whoami` first. Then `create_agent` (once), `set_agent_secrets` for the provider
  keys (the platform provides `KUGELAUDIO_API_KEY`), `create_agent_upload`,
  `deploy_agent`, and `get_playground_link` to call it.
- CLI: `npx curb login` (a person signs in in the browser), `npx curb secrets push`,
  `npx curb deploy` (it prints the playground link). Every option:
  `node_modules/curb/docs/deploy.md`.

When a build or a call fails, read the logs (`get_agent_logs`, or what `curb deploy`
printed), fix the cause and deploy again. No hosted agent tools? `whoami` says why.

## Done

The user has called the agent (the local preview or the playground link), `curb check`
is clean, and you have told them what you changed.
