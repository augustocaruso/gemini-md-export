export type ModalVirtualListMetrics = {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  itemHeight: number;
  virtualItemCount?: number;
};

export type ModalWheelScrollInput = ModalVirtualListMetrics & {
  deltaY: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
};

export type ModalWheelScrollResult = {
  shouldScroll: boolean;
  nextScrollTop: number;
  maxScrollTop: number;
};

const modalFiniteNumber = (value: number, fallback = 0): number =>
  Number.isFinite(value) ? value : fallback;

export const computeModalVirtualScrollRange = ({
  clientHeight,
  scrollHeight,
  itemHeight,
  virtualItemCount = 0,
}: ModalVirtualListMetrics): number => {
  const measuredHeight = Math.max(0, modalFiniteNumber(scrollHeight));
  const viewportHeight = Math.max(0, modalFiniteNumber(clientHeight));
  const estimatedHeight =
    Math.max(0, modalFiniteNumber(virtualItemCount)) * Math.max(0, modalFiniteNumber(itemHeight));
  const effectiveHeight = Math.max(measuredHeight, estimatedHeight);
  return Math.max(0, effectiveHeight - viewportHeight);
};

export const computeModalWheelScroll = ({
  scrollTop,
  deltaY,
  ctrlKey = false,
  metaKey = false,
  ...metrics
}: ModalWheelScrollInput): ModalWheelScrollResult => {
  const currentTop = Math.max(0, modalFiniteNumber(scrollTop));
  const wheelDelta = modalFiniteNumber(deltaY);
  if (!wheelDelta || ctrlKey || metaKey) {
    return { shouldScroll: false, nextScrollTop: currentTop, maxScrollTop: 0 };
  }

  const maxScrollTop = computeModalVirtualScrollRange({
    scrollTop: currentTop,
    ...metrics,
  });
  if (maxScrollTop <= 0) {
    return { shouldScroll: false, nextScrollTop: currentTop, maxScrollTop };
  }

  const nextScrollTop = Math.max(0, Math.min(maxScrollTop, currentTop + wheelDelta));
  return {
    shouldScroll: nextScrollTop !== currentTop,
    nextScrollTop,
    maxScrollTop,
  };
};
