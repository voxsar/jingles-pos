ALTER TABLE "POSUser" ADD COLUMN "email" TEXT;

CREATE UNIQUE INDEX "POSUser_email_key" ON "POSUser"("email");
