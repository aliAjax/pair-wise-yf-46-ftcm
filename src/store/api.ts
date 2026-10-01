import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { RundownItem } from "../types";
import { loadServer, saveServerItems } from "../lib/persistence";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const rundownApi = createApi({
  reducerPath: "rundownApi",
  baseQuery: fakeBaseQuery(),
  tagTypes: ["Rundown"],
  endpoints: (builder) => ({
    getServer: builder.query<RundownItem[], void>({
      queryFn: async () => {
        await delay(300);
        return { data: loadServer() };
      },
      providesTags: ["Rundown"]
    }),
    saveServer: builder.mutation<{ ok: true }, { items: RundownItem[] }>({
      queryFn: async ({ items }) => {
        await delay(500);
        saveServerItems(items);
        return { data: { ok: true } };
      },
      invalidatesTags: ["Rundown"]
    })
  })
});

export const { useGetServerQuery, useSaveServerMutation } = rundownApi;
