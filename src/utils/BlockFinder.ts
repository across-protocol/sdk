export type BlockFinderOpts = {
  highBlock?: number;
  highBlockOffset?: number;
  blockRange?: number;
};

export type BlockTimeAverage = {
  average: number;
  blockRange: number;
  timestamp: number;
};

export interface Block {
  number: number;
  timestamp: number;
}

export type BlockFinderHints = {
  lowBlock?: number;
  highBlock?: number;
};

export abstract class BlockFinder<TBlock extends Block> {
  abstract getBlockForTimestamp(timestamp: number | string, hints: BlockFinderHints): Promise<TBlock>;
}
