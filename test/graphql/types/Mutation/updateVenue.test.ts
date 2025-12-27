import { describe, expect, test, vi, afterEach } from "vitest";

vi.mock("ioredis", () => {
    const Redis = vi.fn(() => ({
        on: vi.fn(),
        quit: vi.fn(),
        defineCommand: vi.fn(),
    }));
    return { default: Redis };
});

import { createMockGraphQLContext } from "../../../_Mocks_/mockContextCreator/mockContextCreator";
import { updateVenueResolver as resolve } from "../../../../src/graphql/types/Mutation/updateVenue";

const VALID_ID = "123e4567-e89b-12d3-a456-426614174000";
const VALID_ORG_ID = "123e4567-e89b-12d3-a456-426614174001";

afterEach(() => {
    vi.clearAllMocks();
});

describe("Mutation.updateVenue", () => {
    const getValidInput = (overrides = {}) => ({
        input: {
            id: VALID_ID,
            name: "Updated Venue Name",
            capacity: 100,
            description: "A valid description of sufficient length.",
            ...overrides
        }
    });

    test("throws unauthenticated error when user is not logged in", async () => {
        const { context } = createMockGraphQLContext(false);
        await expect(resolve({}, getValidInput(), context)).rejects.toMatchObject({
            extensions: { code: "unauthenticated" },
        });
    });

    test("throws invalid_arguments for disallowed mime types (Lines 113, 120)", async () => {
        const { context } = createMockGraphQLContext(true);
        const badFile = { mimetype: "application/javascript", createReadStream: vi.fn() };
        await expect(resolve({}, getValidInput({ 
            attachments: [Promise.resolve(badFile)] 
        }), context)).rejects.toMatchObject({
            extensions: { code: "invalid_arguments" },
        });
    });

    test("throws unauthenticated if authenticated user is missing from DB (Lines 125-130)", async () => {
        const { context, mocks } = createMockGraphQLContext(true, "ghost_user");
        mocks.drizzleClient.query.usersTable.findFirst.mockResolvedValue(undefined);
        await expect(resolve({}, getValidInput(), context)).rejects.toMatchObject({
            extensions: { code: "unauthenticated" },
        });
    });

    test("throws error if venue does not exist", async () => {
        const { context, mocks } = createMockGraphQLContext(true, "user_1");
        mocks.drizzleClient.query.usersTable.findFirst.mockResolvedValue({ role: "administrator" });
        mocks.drizzleClient.query.venuesTable.findFirst.mockResolvedValue(undefined);
        await expect(resolve({}, getValidInput(), context)).rejects.toMatchObject({
            extensions: { code: "arguments_associated_resources_not_found" },
        });
    });

    test("throws error if name is taken by another venue in same org (Lines 154-160)", async () => {
        const { context, mocks } = createMockGraphQLContext(true, "user_1");
        mocks.drizzleClient.query.usersTable.findFirst.mockResolvedValue({ role: "administrator" });
        mocks.drizzleClient.query.venuesTable.findFirst.mockResolvedValueOnce({ 
            organizationId: VALID_ORG_ID, 
            organization: { membershipsWhereOrganization: [] } 
        });
        mocks.drizzleClient.query.venuesTable.findFirst.mockResolvedValueOnce({ id: "another_venue" });

        await expect(resolve({}, getValidInput({ name: "Taken Name" }), context)).rejects.toMatchObject({
            extensions: { code: "forbidden_action_on_arguments_associated_resources" },
        });
    });

    test("throws unauthorized if user is not global admin or org member admin", async () => {
        const { context, mocks } = createMockGraphQLContext(true, "user_1");
        mocks.drizzleClient.query.usersTable.findFirst.mockResolvedValue({ role: "regular" });
        mocks.drizzleClient.query.venuesTable.findFirst.mockResolvedValueOnce({ 
            organizationId: VALID_ORG_ID, 
            organization: { membershipsWhereOrganization: [{ role: "regular" }] },
            attachmentsWhereVenue: []
        });
        mocks.drizzleClient.query.venuesTable.findFirst.mockResolvedValueOnce(undefined);

        await expect(resolve({}, getValidInput(), context)).rejects.toMatchObject({
            extensions: { code: "unauthorized_action_on_arguments_associated_resources" },
        });
    });

    test("throws unexpected error if DB update fails to return row (Lines 183-196)", async () => {
        const { context, mocks } = createMockGraphQLContext(true, "admin_1");
        mocks.drizzleClient.query.usersTable.findFirst.mockResolvedValue({ role: "administrator" });
        mocks.drizzleClient.query.venuesTable.findFirst.mockResolvedValueOnce({ 
            organizationId: VALID_ORG_ID, 
            organization: { membershipsWhereOrganization: [{ role: "administrator" }] },
            attachmentsWhereVenue: []
        });
        mocks.drizzleClient.query.venuesTable.findFirst.mockResolvedValueOnce(undefined);

        (mocks.drizzleClient as any).transaction = vi.fn().mockImplementation(async (cb: any) => {
            return cb({
                update: vi.fn().mockReturnThis(),
                set: vi.fn().mockReturnThis(),
                where: vi.fn().mockReturnThis(),
                returning: vi.fn().mockResolvedValue([]), 
            });
        });

        await expect(resolve({}, getValidInput(), context)).rejects.toMatchObject({
            extensions: { code: "unexpected" },
        });
    });

    test("successfully updates venue returning existing attachments (Lines 279-290)", async () => {
        const { context, mocks } = createMockGraphQLContext(true, "admin_1");
        const existingAtt = [{ id: "att_old" }];
        mocks.drizzleClient.query.usersTable.findFirst.mockResolvedValue({ role: "administrator" });
        mocks.drizzleClient.query.venuesTable.findFirst.mockResolvedValueOnce({
            id: VALID_ID,
            organizationId: VALID_ORG_ID,
            organization: { membershipsWhereOrganization: [{ role: "administrator" }] },
            attachmentsWhereVenue: existingAtt,
        });
        mocks.drizzleClient.query.venuesTable.findFirst.mockResolvedValueOnce(undefined);

        (mocks.drizzleClient as any).transaction = vi.fn().mockImplementation(async (cb: any) => {
            return cb({
                update: vi.fn().mockReturnThis(),
                set: vi.fn().mockReturnThis(),
                where: vi.fn().mockReturnThis(),
                returning: vi.fn().mockResolvedValue([{ id: VALID_ID, name: "New Name" }]),
            });
        });

        const result = await resolve({}, getValidInput({ name: "New Name" }), context);
        expect(result.attachments).toEqual(existingAtt);
    });

    test("successfully updates venue and replaces attachments (Lines 223-226)", async () => {
        const { context, mocks } = createMockGraphQLContext(true, "admin_1");
        const mockFile = { createReadStream: vi.fn().mockReturnValue({ on: vi.fn() }), mimetype: "image/png" };

        mocks.drizzleClient.query.usersTable.findFirst.mockResolvedValue({ role: "administrator" });
        mocks.drizzleClient.query.venuesTable.findFirst.mockResolvedValueOnce({
            id: VALID_ID,
            organizationId: VALID_ORG_ID,
            organization: { membershipsWhereOrganization: [{ role: "administrator" }] },
            attachmentsWhereVenue: [{ id: "old_att" }], 
        });
        mocks.drizzleClient.query.venuesTable.findFirst.mockResolvedValueOnce(undefined);

        const deleteMock = vi.fn().mockReturnThis();

        (mocks.drizzleClient as any).transaction = vi.fn().mockImplementation(async (cb: any) => {
            return cb({
                update: vi.fn().mockReturnThis(),
                set: vi.fn().mockReturnThis(),
                where: vi.fn().mockReturnThis(),
                returning: vi.fn()
                    .mockResolvedValueOnce([{ id: VALID_ID, name: "New Name" }])
                    .mockResolvedValueOnce([{ id: "new_att", name: "file", mimeType: "image/png" }]),
                delete: deleteMock,
                insert: vi.fn().mockReturnThis(),
                values: vi.fn().mockReturnThis(),
            });
        });

        context.minio.client.putObject = vi.fn().mockResolvedValue({});
        const result = await resolve({}, getValidInput({ attachments: [Promise.resolve(mockFile)] }), context);
        
        expect(deleteMock).toHaveBeenCalled();
        expect(result.attachments).toHaveLength(1);
    });

    test("handles partial upload and MinIO cleanup loop (Line 259-265)", async () => {
        const { context, mocks } = createMockGraphQLContext(true, "admin_1");
        const file1 = { createReadStream: vi.fn().mockReturnValue({}), mimetype: "image/png" };
        const file2 = { createReadStream: vi.fn().mockReturnValue({}), mimetype: "image/png" };

        mocks.drizzleClient.query.usersTable.findFirst.mockResolvedValue({ role: "administrator" });
        mocks.drizzleClient.query.venuesTable.findFirst.mockResolvedValueOnce({
            organizationId: VALID_ORG_ID,
            organization: { membershipsWhereOrganization: [{ role: "administrator" }] },
            attachmentsWhereVenue: [],
        });
        mocks.drizzleClient.query.venuesTable.findFirst.mockResolvedValueOnce(undefined);

        (mocks.drizzleClient as any).transaction = vi.fn().mockImplementation(async (cb: any) => {
            return cb({
                update: vi.fn().mockReturnThis(),
                set: vi.fn().mockReturnThis(),
                where: vi.fn().mockReturnThis(),
                returning: vi.fn()
                    .mockResolvedValueOnce([{ id: VALID_ID }])
                    .mockResolvedValueOnce([
                        { id: "a1", name: "cleanup_1", mimeType: "image/png" },
                        { id: "a2", name: "cleanup_2", mimeType: "image/png" }
                    ]),
                delete: vi.fn().mockReturnThis(),
                insert: vi.fn().mockReturnThis(),
                values: vi.fn().mockReturnThis(),
            });
        });

        const removeSpy = vi.fn().mockResolvedValue({});
        context.minio.client.removeObject = removeSpy;
        context.minio.client.putObject = vi.fn()
            .mockResolvedValueOnce({}) 
            .mockRejectedValueOnce(new Error("MinIO Fail")); 

        await expect(resolve({}, getValidInput({ 
            attachments: [Promise.resolve(file1), Promise.resolve(file2)] 
        }), context)).rejects.toThrow("MinIO Fail");
        
        expect(removeSpy).toHaveBeenCalledWith(expect.any(String), "cleanup_1");
    });
});
