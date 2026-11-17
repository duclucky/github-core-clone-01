# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/duclucky/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/duclucky/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process, standard library only. It serves git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4, and MCP from its own in-memory store, with no UI, no git binary, and no outside service.

## Run it

```sh
node main.ts
```

The process binds an ephemeral port, registers it with the trial env at `$MAKEFUN_ENV_URL`, serves until the env answers `{"done": true}`, then exits 0. See `RULES.md` in the kit for the full wire contract.

---

<sub>Entered on [make.fun](https://make.fun/?ref=aa495h0y&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
