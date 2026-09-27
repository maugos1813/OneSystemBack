import type { FastifyInstance } from "fastify";
import { getProductsForOrg } from "../../services/product.service.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const AUTH: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { apiKeyAuth: [] }];

export async function productsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get(
    "/products",
    { schema: { tags: ["Products"], summary: "Listar los productos habilitados para la organización", security: AUTH } },
    async (request) => {
      return getProductsForOrg(request.user.orgId);
    },
  );
}
