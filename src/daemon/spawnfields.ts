// The spawn fields shared by the MCP spawn tool and the WebSocket spawn message; `tl spawn` maps its flags onto the same keys.
import { z } from 'zod';
import { EFFORTS, ISOLATIONS, NODE_KINDS, ROLES } from '../shared/protocol.js';

const id = z.string().min(1);

export const SPAWN_FIELDS = {
  kind: z.enum(NODE_KINDS), title: z.string().min(1), cwd: z.string().min(1), prompt: z.string().optional(),
  model: z.string().optional(), effort: z.enum(EFFORTS).optional(), role: z.enum(ROLES).optional(), isolation: z.enum(ISOLATIONS).optional(),
  preset: z.string().min(1).optional(), after: z.array(id).optional(), afterSuccess: z.array(id).optional(), now: z.boolean().optional(), fork: id.optional(),
};
