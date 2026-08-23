# Block contract

Every prefab block declares:

- stable `id` and `kind`;
- relative asset path;
- capabilities it requires;
- capabilities it provides;
- explicit degraded behavior;
- deterministic smoke check.

Constructor selects smallest compatible set. This metadata guides agent reasoning; it is not a runtime plugin system.

Generated glue belongs inside learning directory and must be recorded in `session.json`. Never modify kit assets during ordinary construction.
