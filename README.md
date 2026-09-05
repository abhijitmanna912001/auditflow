# AuditFlow

An autonomous AI agent system that prepares audit-ready workpapers from financial documents, flagging missing evidence, mismatches, duplicates, and anomalies, and routing only unresolved cases to human review.

Built for Syndicate by Maximor (AO Hackathon), Track 2: Autonomous Office of the CFO.

## What it does
(to be filled in)

## How to run it
(to be filled in)

## Agent workflow
Intake Agent -> Evidence Agent -> Anomaly Agent -> Decision Agent -> Workpaper Agent

Orchestrated using AO (Agent Orchestrator). Traced and evaluated using Neatlogs.

## What improved across iterations
(to be filled in, V1 vs V2 benchmark results)

## Project structure
- /agents - agent logic (Intake, Evidence, Anomaly, Decision, Workpaper)
- /orchestration - AO orchestration wiring
- /evaluation - benchmark runner, V1/V2 comparison scripts
- /frontend - workpaper UI (React)
- /dataset - benchmark cases + ground truth JSON
- /docs - demo script, notes

## Team
- Abhijit Manna - agent logic, orchestration, evaluation
- Garvit Mathur - dataset, frontend, testing

## Track
Track 2: Autonomous Office of the CFO
