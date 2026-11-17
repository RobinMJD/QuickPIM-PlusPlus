# QuickPIM picomatch fork

This private, development-only package derives from the [picomatch 4.0.7 npm release](https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz). The upstream tarball has integrity `sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==`. The upstream license and copyright are in [LICENSE](LICENSE).

The parser rejects repeat extglobs (`+()` and `*()`) at the shared opener and disables raw regex plus and star quantifier handling. QuickPIM's tooling uses ordinary globs, braces and optional extglobs. It does not rely on repeat extglobs or raw regex plus/star quantifiers in globs. This restriction removes the affected parser route described in [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf).

The root npm override routes each build and test tool to this source. The dependency tests check resolution and the restricted syntax. Replace the fork and override together when a verified upstream fix is released.
