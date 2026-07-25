# storage

Persistence for sessions and memory.

Empty on purpose.
The backend is an open decision ([issue #11](https://github.com/seahsky/cadence-agent/issues/11)), blocked on both the session boundary ([#9](https://github.com/seahsky/cadence-agent/issues/9)) and the memory architecture ([#10](https://github.com/seahsky/cadence-agent/issues/10)) — the schema is downstream of both.

Standing bias: boring wins. A single SQLite file is easy to back up, easy to inspect, and hard to outgrow at one-operator scale. Human-readable markdown may earn a place alongside it for anything the owner might want to read or edit by hand. Nothing here gets a vector database until the memory design has actually asked for one.
