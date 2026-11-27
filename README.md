# Tableau → Power BI / Fabric Migration Toolkit

For engineers migrating Tableau workbooks (`.twb` / `.twbx`) to a reviewable local
Power BI project (PBIP): a semantic model and report. The default route prepares
selected sources and hands them to GitHub Copilot builders and an independent
comparison agent. Deterministic conversion remains an explicit advanced route.

> Unofficial personal/community proof of concept, not an official Microsoft, GitHub
> or Tableau product, nor sponsored, endorsed or maintained by them. Contributors
> act in a personal capacity.

![The Price of Prosperity: Tableau (left) and Power BI (right)](docs/showcase/assets/price-of-prosperity-1.png)

*The Price of Prosperity: Tableau (left), Power BI (right). [Source and details](docs/showcase/README.md#the-price-of-prosperity).*

## Get started

**[Set up the toolkit and start a migration](docs/operator-runbook.md#start-here).**
Choose explicit `--mode single|batch`, `--style one-to-one|modernize` and
`--numeric none|required`. Single-workbook runs choose `--assessment skip|run`;
batch runs assess the exact selected project scope, not the whole site.
Use [the local-workbook guide](docs/start-with-one-workbook.md) for offline source
preparation. Just browsing? No installation is needed.

## Before you run

- **Environment:** Windows with Power BI Desktop, Git, GitHub Copilot CLI,
  Python 3.11+, `uv` and Node.js 20+. Setup checks tools, plugins and MCP servers.
  The simple route does not run the separately installed conversion engine.
  Linux contributor tests and offline parsing are not live Tableau/Desktop acceptance.
- **Expect a draft, not guaranteed fidelity.** Preparation or authoring success is not sign-off.
  Require independent comparison with Tableau, using real data for agreed numeric
  checks; the simple route's comparison is advisory, with unverified scope disclosed,
  not a package COMPLETE verdict. Fabric deployment requires separate approval.
- **Human stops remain human.** Sign-in, credentials and security/privacy approval
  dialogs need a person; agents must not bypass them.
- **Keep customer material private:** workbooks, rows, screenshots and secrets
  must not enter Git. Verify in-repo output paths are ignored; see
  [Security and privacy](SECURITY.md).

## Learn more

- [Before/after showcase](docs/showcase/README.md): public examples and their sources.
- [Capabilities and limitations](docs/capabilities-and-limitations.md): what needs verification.
- [Documentation map](docs/INDEX.md): operations, architecture and reference.
- [Contributing](CONTRIBUTING.md): development and review.

[MIT license](LICENSE).
