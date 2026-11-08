# Preset clash rule sets

Seven built-in rule templates. Each one says "elements of type X from
discipline A vs elements of type Y from discipline B" — the project file
provides the actual IFCs, with their `discipline` tag mapping them to
the right side.

## Format

```json
{
  "name": "HVACxSTR",
  "description": "Ducts (HVAC) vs structural beams and columns. Usually critical.",
  "sideA": { "selector": "IfcDuct*", "discipline": "HVAC" },
  "sideB": { "selector": "IfcBeam|IfcColumn", "discipline": "STR" }
}
```

## How a preset gets used

In your `.clashproj`, reference a preset by name:

```json
"rules": [
  { "name": "HVACxSTR", "preset": "HVACxSTR", "enabled": true }
]
```

`clashtester run` resolves the preset by looking in `presets/` for a file
whose `name` matches. It then expands the rule into a custom-shape rule
using:
- every file with `discipline = "HVAC"` on side A (selector `IfcDuct*`)
- every file with `discipline = "STR"` on side B (selector `IfcBeam|IfcColumn`)

If no files match a side's discipline, the rule is skipped with a warning.

## The thirteen shipped presets

Each preset's selectors are deliberately broad — the ARCH side includes
doors and windows, the HVAC side includes equipment like fans and
chillers, etc. This matches how disciplines are tagged in real
federated projects (informed by Clashero's discipline tables).

### Services vs structure (the most critical — usually run first)

| File | Side A | Side B | Why |
|---|---|---|---|
| `MEPxSTR.json` | MEP equipment + piping | Beams/columns/foundations | Pipes through structure block construction |
| `HVACxSTR.json` | HVAC equipment + ducts | Beams/columns/foundations | Ducts through beams force rework |
| `ELECxSTR.json` | Cables/trays + electrical | Beams/columns/foundations | Cable routes vs structural members |
| `FIRExSTR.json` | Fire pipes + sprinklers | Beams/columns/foundations | Sprinkler routing — life-safety critical |

### Services vs architecture (penetration sleeves, headroom, openings)

| File | Side A | Side B | Why |
|---|---|---|---|
| `HVACxARCH.json` | HVAC equipment + ducts | Walls/slabs/roofs/doors/windows | Penetration sleeves + headroom |
| `MEPxARCH.json` | MEP equipment + piping | Walls/slabs/roofs/doors/windows | Penetration sleeves |
| `ELECxARCH.json` | Cables + lighting + outlets | Walls/slabs/doors/windows | Outlet placement, light positioning |
| `FIRExARCH.json` | Fire pipes + sprinklers | Walls/slabs/roofs/doors/windows | Sprinkler penetration sleeves |

### Service-vs-service (shared shafts and plenums)

| File | Side A | Side B | Why |
|---|---|---|---|
| `HVACxMEP.json` | HVAC equipment + ducts | MEP equipment + piping | Plenum/shaft routing |
| `ELECxMEP.json` | Electrical | MEP piping | Separation rules — minor |
| `FIRExMEP.json` | Fire pipes + sprinklers | MEP piping | Shared shaft routing |

### Cross-discipline shell checks

| File | Side A | Side B | Why |
|---|---|---|---|
| `STRxARCH.json` | Structure | Architecture | Cross-discipline alignment of cores and shell |
| `STAIRxSTR.json` | Stairs / ramps / railings | Beams/slabs | Headroom — beam above a stair landing |

### Things deliberately NOT shipped (yet)

- **Self-clashes** (e.g. HVAC-vs-HVAC). Requires a small engine fix to
  skip same-element pairs before it'd be useful. Add later if needed.
- **EQUIPMENTxSTR**. "Equipment" tags vary too much by project
  convention to ship as a generic preset.
- **GEOxSTR / GEOxARCH**. Geo content is project-specific; better as
  custom rules.

### Discipline lookup (informational)

For reference, the broad discipline → IFC types mapping behind the
selectors (mirrors Clashero's table):

- **ARCH**: `IfcWall*`, `IfcSlab*`, `IfcRoof`, `IfcCurtainWall*`,
  `IfcDoor*`, `IfcWindow*`, `IfcStair*`, `IfcRailing`, `IfcCovering`
- **STR**: `IfcBeam*`, `IfcColumn*`, `IfcSlab*`, `IfcFoundation*`,
  `IfcPile`, `IfcFooting*`, `IfcMember*`, `IfcPlate`, `IfcReinforcingElement*`
- **HVAC**: `IfcDuct*`, `IfcAirTerminal*`, `IfcUnitaryEquipment`,
  `IfcFan`, `IfcCompressor`, `IfcCoil`, `IfcHumidifier`, `IfcChiller`,
  `IfcBoiler`, `IfcDamper*`, `IfcFilter*`, `IfcSpaceHeater`,
  `IfcHeatExchanger`
- **MEP**: `IfcPipe*`, `IfcPump*`, `IfcValve*`, `IfcTank*`,
  `IfcSanitaryTerminal`, `IfcFlowFitting*`, `IfcFlowSegment*`,
  `IfcFlowController*`, `IfcFlowStorageDevice*`, `IfcHeatExchanger`,
  `IfcInterceptor`
- **ELEC**: `IfcCable*`, `IfcCableCarrier*`, `IfcElectric*`,
  `IfcLightFixture`, `IfcOutlet`, `IfcSwitchingDevice*`,
  `IfcProtectiveDevice*`, `IfcCommunicationsAppliance`,
  `IfcDistributionControlElement`
- **FIRE**: `IfcPipe*`, `IfcFireSuppressionTerminal`,
  `IfcFlowFitting*`, `IfcFlowSegment*`, `IfcValve*`, `IfcAlarm`,
  `IfcSensor`
- **GEO**: `IfcSite`, `IfcGeographicElement*`, `IfcEarthworksCut`,
  `IfcEarthworksFill`, `IfcPavement`, `IfcRoad*`, `IfcBridge*`

