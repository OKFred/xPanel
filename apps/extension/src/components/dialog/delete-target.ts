export type DeleteTarget =
  | { kind: "request"; id: string; name: string }
  | {
      kind: "collection";
      id: string;
      name: string;
      requestCount: number;
      exclusiveRequestCount: number;
      sharedRequestCount: number;
    };
