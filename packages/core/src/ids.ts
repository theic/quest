/**
 * Ids are strings at runtime. The brand makes them distinct types, so a task id
 * can never be passed where a customer id is expected.
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type CustomerId = Brand<string, "CustomerId">;
export type TaskId = Brand<string, "TaskId">;
export type QuestionId = Brand<string, "QuestionId">;
export type FindId = Brand<string, "FindId">;
export type DraftId = Brand<string, "DraftId">;

export const customerId = (s: string): CustomerId => s as CustomerId;
export const taskId = (s: string): TaskId => s as TaskId;
export const questionId = (s: string): QuestionId => s as QuestionId;
export const findId = (s: string): FindId => s as FindId;
export const draftId = (s: string): DraftId => s as DraftId;
