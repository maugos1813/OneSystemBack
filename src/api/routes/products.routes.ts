import type { FastifyInstance } from "fastify";
import { getCurrentUser } from "../../services/auth.service.js";
import { getProductsForUser } from "../../services/product.service.js";
import { createSsoTicket } from "../../services/sso.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

export async function productsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get(
    "/products",
    { schema: { tags: ["Products"], summary: "Listar los productos habilitados para la organización", security: AUTH } },
    async (request) => {
      return getProductsForUser(request.user.orgId, request.user.userId, request.user.role);
    },
  );

  app.get(
    "/products/:key/sso-url",
    {
      schema: {
        tags: ["Products"],
        summary: "URL con ticket de sesión para entrar a un producto externo sin loguearse de nuevo",
        security: AUTH,
      },
    },
    async (request, reply) => {
      const { key } = request.params as { key: string };
      const products = await getProductsForUser(request.user.orgId, request.user.userId, request.user.role);
      const product = products.find((p) => p.key === key);

      if (!product || product.type !== "external" || !product.url) {
        return reply.code(404).send({ error: "Product not found" });
      }
      if (!product.ssoEnabled) {
        return reply.code(400).send({ error: "This product does not support single sign-on" });
      }

      const currentUser = await getCurrentUser(request.user.userId);
      if (!currentUser) return reply.code(401).send({ error: "Unauthorized" });

      let ticket: string;
      try {
        ticket = createSsoTicket({ email: currentUser.email, productKey: key });
      } catch {
        return reply.code(503).send({ error: "SSO is not configured for this environment" });
      }

      const separator = product.url.includes("?") ? "&" : "?";
      return { url: `${product.url}${separator}sso=${ticket}` };
    },
  );
}
