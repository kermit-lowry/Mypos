import { Prisma, PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;
