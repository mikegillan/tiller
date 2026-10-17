// The spawn fields shared by the MCP spawn tool and the WebSocket spawn message; `tl spawn` maps its flags onto the same keys.
import { z } from 'zod';
import { EFFORTS, HARNESSES, ISOLATIONS, NODE_KINDS, ROLES, type Harness, type NodeKind } from '../shared/protocol.js';

const id = z.string().min(1);

export const SPAWN_FIELDS = {
  kind: z.enum(NODE_KINDS), harness: z.enum(HARNESSES).optional(), title: z.string().min(1), cwd: z.string().min(1), prompt: z.string().optional(),
  model: z.string().optional(), effort: z.enum(EFFORTS).optional(), role: z.enum(ROLES).optional(), isolation: z.enum(ISOLATIONS).optional(), base: z.string().min(1).optional(),
  preset: z.string().min(1).optional(), after: z.array(id).optional(), afterSuccess: z.array(id).optional(), now: z.boolean().optional(), fork: id.optional(),
};

/** `tl spawn`'s kind when `--kind` is omitted: a non-Claude `--harness` means an agent node, anything else stays unset (legacy default). */
export const spawnKind = (kind: NodeKind | undefined, harness: Harness | undefined): NodeKind | undefined =>
  kind ?? (harness && harness !== 'claude' ? 'agent' : undefined);
