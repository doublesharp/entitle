import type { FastifyReply, FastifyRequest } from "fastify";

// Authenticated, admitted handlers use explicit idle/total operation deadlines.
// No response bytes can be sent until private artifacts have been verified.
export function handlerOwnsSocketTimeout(
  req: FastifyRequest,
  reply: FastifyReply,
  fallbackTimeoutMs: number,
) {
  const socket = req.raw.socket;
  socket.setTimeout?.(0);
  const restore = () => {
    reply.raw.off("finish", restore);
    reply.raw.off("close", restore);
    socket.setTimeout?.(fallbackTimeoutMs);
  };
  reply.raw.once("finish", restore);
  reply.raw.once("close", restore);
}
