CREATE TABLE "LegacyPOSRecord" (
    "sourceTable" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "firstSyncedAt" DATETIME NOT NULL,
    "lastSyncedAt" DATETIME NOT NULL,
    PRIMARY KEY ("sourceTable", "sourceId")
);

CREATE INDEX "LegacyPOSRecord_sourceTable_idx" ON "LegacyPOSRecord"("sourceTable");
