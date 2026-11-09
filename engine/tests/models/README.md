# Test models — sources and terms

Every IFC file in this folder, where it comes from and under which
terms it may be used. Checked 2026-11-04 against the
original sources: hashes compared byte for byte, or after normalising
line endings.

| File | Source | Terms |
|---|---|---|
| `Building-Architecture.ifc`, `Building-Hvac.ifc`, `Building-Structural.ifc` | buildingSMART International, "PCERT Sample Scene" (IFC 4.0.2.1). Repository [`buildingSMART/Certification-datasets`](https://github.com/buildingSMART/Certification-datasets), folder `IFC 4.0.2.1 (IFC 4)/PCERT-Sample-Scene/` at commit `cecf656` (2026-05-21). That folder is now `…/Simple-Scene/`, which holds newer exports. | **CC BY 4.0**, © buildingSMART International Ltd. — <https://creativecommons.org/licenses/by/4.0/>. Byte-identical to the source and **unmodified**. |
| `AC20-FZK-Haus.ifc` | KIT IFC Examples, FZK-Haus (ArchiCAD 20 export, 2016), <https://www.ifcwiki.org/index.php?title=KIT_IFC_Examples>, file <http://www.ifcwiki.org/images/e/e3/AC20-FZK-Haus.ifc> | **"for unrestricted use"** (ifcwiki). In publications, credit: *Institute for Automation and Applied Informatics (IAI) / Karlsruhe Institute of Technology (KIT)*. The content is identical to the source; only the line endings were changed (CRLF → LF). |
| `opening-cut.ifc`, `units-m.ifc`, `units-mm.ifc`, `ifc2x3-mep-types.ifc`, `geometry-failed.ifc` | Hand-written for Clash Tester. Their headers say `'Clash Tester'`, `'hand-written'`. | Ours: **Apache-2.0**, like the rest of the repo. |

How these reached the repo: the four public models came with the
Clashero engine copy (see `../../VENDORED.md`). The small fixtures were
written in this project.

The example projects in `examples/` use the three buildingSMART models.
Their `outputs/` (BCF, JSON, CSV) are clash results computed from those
models, so the same CC BY 4.0 credit applies to them.

**Size.** Together about 3.2 MB, most of it FZK-Haus (2.5 MB). They stay
in the repo instead of being fetched at test time: tests must run
offline and stay reproducible, and the size is small.

**Adding a model:** add a row here with its source, its terms, and
whether it was changed, and only use models whose terms allow
redistribution in an Apache-2.0 repository.
