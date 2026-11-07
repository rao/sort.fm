import { z } from "zod";
import * as contracts from "../packages/contracts/src/index";
import { demoBootstrap } from "../packages/contracts/src/fixtures";

const schemas = Object.fromEntries(Object.entries(contracts).filter(([name, value]) => name.endsWith("Schema") && value instanceof z.ZodType).map(([name, value]) => [name, z.toJSONSchema(value as z.ZodType, {io: "input"})]));
const routes = (registry: typeof contracts.PUBLIC_ROUTES | typeof contracts.INTERNAL_ROUTES) => Object.fromEntries(Object.entries(registry).map(([name, route]) => [name, {method: route.method, path: route.path, auth: route.auth, ...("body" in route ? {body: z.toJSONSchema(route.body, {io: "input"})} : {}), ...("query" in route ? {query: z.toJSONSchema(route.query, {io: "input"})} : {}), ...("response" in route ? {response: z.toJSONSchema(route.response, {io: "output"})} : {})}]));
const artifact = {contractVersion: contracts.CONTRACT_VERSION, featureVersion: contracts.FEATURE_VERSION, warning: "Zod cross-field refinements are also normative; JSON Schema consumers must enforce docs/contracts.md invariants.", schemas, publicRoutes: routes(contracts.PUBLIC_ROUTES), internalRoutes: routes(contracts.INTERNAL_ROUTES)};
const path = new URL("../packages/contracts/generated/contracts.schema.json", import.meta.url);
await Bun.write(path, JSON.stringify(artifact, null, 2) + "\n");
await Bun.write(new URL("../packages/contracts/generated/demo-bootstrap.json", import.meta.url), JSON.stringify(demoBootstrap, null, 2) + "\n");
console.log(`Exported ${Object.keys(schemas).length} schemas and route contracts to packages/contracts/generated/contracts.schema.json`);
