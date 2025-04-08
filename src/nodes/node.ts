import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";

type NodeState = {
  killed: boolean;
  x: 0 | 1 | "?" | null;
  decided: boolean | null;
  k: number | null;
};

function countVotes(values: Iterable<Value>) {
  const counts: Record<Value, number> = { 0: 0, 1: 0, "?": 0 };
  for (const v of values) {
    if (isValidValue(v)) counts[v]++;
  }
  return counts;
}

function decideFromCounts(counts: Record<Value, number>, threshold: number): Value | null {
  if (counts[0] > threshold) return 0;
  if (counts[1] > threshold) return 1;
  return null;
}

function isValidValue(v: any): v is Value {
  return v === 0 || v === 1 || v === "?";
}

export async function node(
  nodeId: number,
  N: number,
  F: number,
  initialValue: Value,
  isFaulty: boolean,
  nodesAreReady: () => boolean,
  setNodeIsReady: (index: number) => void
) {
  const app = express();
  app.use(express.json());
  app.use(bodyParser.json());

  const state: NodeState = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  const messages: {
    [round: number]: {
      phase1: Map<number, Value>;
      phase2: Map<number, Value>;
    };
  } = {};

  let running = false;

  app.get("/status", (_req, res) => {
    return isFaulty
      ? res.status(500).send("faulty")
      : res.status(200).send("live");
  });

  app.get("/getState", (_req, res) => {
    return res.status(200).json({
      killed: state.killed,
      x: isFaulty ? null : state.x,
      decided: isFaulty ? null : state.decided,
      k: isFaulty ? null : state.k,
    });
  });

  app.post("/message", (req, res) => {
    if (isFaulty || state.killed || state.decided) return res.sendStatus(200);

    const { round, phase, sender, value } = req.body;

    if (!messages[round]) {
      messages[round] = {
        phase1: new Map(),
        phase2: new Map(),
      };
    }

    if (phase === 1) messages[round].phase1.set(sender, value);
    else if (phase === 2) messages[round].phase2.set(sender, value);

    return res.sendStatus(200);
  });

  const broadcastToAllNodes = async (
    round: number,
    phase: 1 | 2,
    sender: number,
    value: Value
  ) => {
    const body = {
      sender,
      round,
      phase,
      value,
    };
    for (let i = 0; i < N; i++) {
      if (i === sender) continue;
      try {
        await fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        // Network failure or node down — ignore
      }
    }
  };

  app.get("/start", async (_req, res) => {
    if (isFaulty || running) return res.send("OK");
    running = true;

    (async () => {
      while (!state.killed && !state.decided) {
        state.k = (state.k ?? 0) + 1;
        const round = state.k;

        if (!messages[round]) {
          messages[round] = {
            phase1: new Map(),
            phase2: new Map(),
          };
        }

        // PHASE 1
        const proposal = state.x ?? (Math.random() < 0.5 ? 0 : 1);
        messages[round].phase1.set(nodeId, proposal);
        await broadcastToAllNodes(round, 1, nodeId, proposal);

        while (
          messages[round].phase1.size < N - F &&
          !state.killed &&
          !state.decided
        ) {
          await new Promise((r) => setTimeout(r, 5));
        }

        const phase1Counts = countVotes(messages[round].phase1.values());
        let b: Value = "?";
        if (phase1Counts[0] > N / 2) b = 0;
        else if (phase1Counts[1] > N / 2) b = 1;

        // PHASE 2
        messages[round].phase2.set(nodeId, b);
        await broadcastToAllNodes(round, 2, nodeId, b);

        while (
          messages[round].phase2.size < N - F &&
          !state.killed &&
          !state.decided
        ) {
          await new Promise((r) => setTimeout(r, 5));
        }

        const phase2Counts = countVotes(messages[round].phase2.values());
        const decision = decideFromCounts(phase2Counts, F);

        if (decision !== null) {
          state.x = decision;
          state.decided = true;
          break;
        }

        // No decision yet, update proposal or random
        if (phase2Counts[0] > 0 || phase2Counts[1] > 0) {
          state.x = phase2Counts[0] >= phase2Counts[1] ? 0 : 1;
        } else {
          state.x = Math.random() < 0.5 ? 0 : 1;
        }
      }

      running = false;
    })();

    return res.send("OK");
  });

  app.get("/stop", (_req, res) => {
    state.killed = true;
    running = false;
    return res.send("OK");
  });

  const server = app.listen(BASE_NODE_PORT + nodeId, () => {
    console.log(`Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}
