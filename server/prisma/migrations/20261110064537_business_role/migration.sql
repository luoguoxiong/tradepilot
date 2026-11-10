-- CreateEnum
CREATE TYPE "BusinessRole" AS ENUM ('IMPORTER', 'SUPPLIER', 'UNCLEAR');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "businessRole" "BusinessRole",
ADD COLUMN     "roleSignals" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "SearchTask" ADD COLUMN     "filteredCount" INTEGER NOT NULL DEFAULT 0;
