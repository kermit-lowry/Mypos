-- The BACK_OFFICE_LOGIN permission is gone: website access is now a separate
-- website-user account. Drop the key from saved role policies and per-employee
-- overrides so no client ever sees (or sends back) the retired permission.
UPDATE "RolePolicy" SET "permissions" = "permissions" - 'BACK_OFFICE_LOGIN' WHERE "permissions" ? 'BACK_OFFICE_LOGIN';
UPDATE "Staff" SET "permissionOverrides" = "permissionOverrides" - 'BACK_OFFICE_LOGIN' WHERE "permissionOverrides" ? 'BACK_OFFICE_LOGIN';
