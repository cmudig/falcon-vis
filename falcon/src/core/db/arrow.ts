import { BitSet, union } from "../bitset";
import { BinnedCounts, FalconDB, SyncIndex } from "./db";
import { FalconArray } from "../falconArray";
import {
  binNumberFunctionContinuous,
  binNumberFunctionBinsContinuous,
  numBinsContinuous,
} from "../util";
import { View0D, View1D } from "../views";
import type { AsyncOrSync, Filters } from "./db";
import type {
  CategoricalDimension,
  CategoricalRange,
  ContinuousDimension,
  ContinuousRange,
  Dimension,
} from "../dimension";
import type { Interval } from "../util";
import type { View } from "../views";
import type { Table, Vector } from "apache-arrow";

type DimensionFilterHash = string;
type FilterMasks<T> = Map<T, BitSet>;

export class ArrowDB implements FalconDB {
  readonly blocking: boolean;
  data: Table;
  filterMaskIndex: FilterMasks<DimensionFilterHash>;

  /**
   * Falcon Database using arrow data columnar table
   *
   * Starts by saving data by reference and
   * indicates that we have synchronous calls that are blocking
   *
   * @note [arrow specification](https://arrow.apache.org/docs/format/Columnar.html)
   * @note [arrow wes mckinney video](https://www.youtube.com/watch?v=fyj4FyH3XdU)
   */
  constructor(data: Table) {
    this.blocking = true;
    // bitmask to determine what rows filter out or not
    this.filterMaskIndex = new Map();
    this.data = data;
  }

  length(): AsyncOrSync<number> {
    return this.data.numRows;
  }

  range(dimension: Dimension) {
    const arrowColumn = this.data.getChild(dimension.name);
    const arrowColumnExists = arrowColumn !== null;
    if (arrowColumnExists) {
      const possibleValues =
        dimension.type === "continuous" ? arrowColumnExtent : arrowColumnUnique;
      return possibleValues(arrowColumn);
    } else {
      throw Error(
        `Dimension name ${dimension.name} wasn't found on the arrow table`
      );
    }
  }

  histogramView1D(view: View1D, filters?: Filters): BinnedCounts {
    let filter: FalconArray;
    let noFilter: FalconArray;
    let bin: (item: any) => number;
    let binCount: number;

    // 1. decide which rows are filtered or not
    const filterMask: BitSet | null = union(
      ...this.getFilterMasks(filters ?? new Map()).values()
    );

    // 2. allocate memory for the bins
    if (view.dimension.type === "continuous") {
      const binConfig = view.dimension.binConfig!;
      binCount = numBinsContinuous(binConfig);
      bin = binNumberFunctionContinuous(binConfig);

      noFilter = FalconArray.allocCounts(binCount);
      filter = filterMask ? FalconArray.allocCounts(binCount) : noFilter;
    } else {
      binCount = view.dimension.range!.length;
      const binMapper = new Map(
        view.dimension.range!.map((item, index) => [item, index])
      );
      bin = (item: any) => binMapper.get(item)!;

      noFilter = FalconArray.allocCounts(binCount);
      filter = filterMask ? FalconArray.allocCounts(binCount) : noFilter;
    }

    // 3. iterate over the row values and determine which bin to increment
    const column = this.data.getChild(view.dimension.name)!;
    for (let i = 0; i < this.data.numRows; i++) {
      const value: any = column.get(i)!;
      const binLocation = bin(value);

      // increment the specific bin
      if (0 <= binLocation && binLocation < binCount) {
        noFilter.increment([binLocation]);
        if (filterMask && !filterMask.get(i)) {
          filter.increment([binLocation]);
        }
      }
    }

    // 5. return the results
    return {
      noFilter,
      filter,
    };
  }

  falconIndexView1D(
    activeView: View1D,
    passiveViews: View[],
    filters: Filters
  ) {
    const filterMasks = this.getFilterMasks(filters);
    const cubes: SyncIndex = new Map();

    if (activeView.dimension.type === "continuous") {
      // 1. bin mapping functions
      const pixels = activeView.dimension.resolution;
      const activeDim = activeView.dimension;
      const binActive = binNumberFunctionBinsContinuous(
        activeDim.binConfig!,
        pixels
      );
      const activeCol = this.data.getChild(activeDim.name)!;
      const numPixels = pixels + 1; // extending by one pixel so we can compute the right diff later

      // 2. iterate over each passive view to compute cubes
      passiveViews.forEach((view) => {
        const cube = this.cubeSlice1D(
          view,
          activeCol,
          filterMasks,
          numPixels,
          binActive
        );
        cubes.set(view, cube);
      });
    } else {
      throw Error("categorical not implemented yet");
    }

    return cubes;
  }

  /**
   * Takes a view and computes the falcon cube for that passive view
   * more details in the [paper](https://idl.cs.washington.edu/files/2019-Falcon-CHI.pdf)
   *
   * @note Only works for 0D and 1D continuous views at the moment
   * @returns a cube as FalconArray for the passive view
   */
  cubeSlice1D(
    view: View,
    activeCol: Vector,
    filterMasks: FilterMasks<Dimension>,
    numPixels: number,
    binActive: (x: number) => number
  ) {
    let noFilter: FalconArray;
    let filter: FalconArray;

    // 2.1 only filter all other dimensions (filter on same dimension does not apply)
    const relevantMasks = new Map(filterMasks);
    if (view instanceof View0D) {
      // use all filters
    } else if (view instanceof View1D) {
      // remove itself from filtering
      relevantMasks.delete(view.dimension);
    }
    const filterMask = union(...relevantMasks.values());

    // 2.2 this count counts for each pixel wise bin
    if (view instanceof View0D) {
      filter = FalconArray.allocCumulative(numPixels);
      noFilter = FalconArray.allocCounts(1, [1]);

      // add data to aggregation matrix
      for (let i = 0; i < this.data.numRows; i++) {
        // ignore filtered entries
        if (filterMask && filterMask.get(i)) {
          continue;
        }

        const keyActive = binActive(activeCol.get(i)!) + 1;
        if (0 <= keyActive && keyActive < numPixels) {
          filter.increment([keyActive]);
        }
        noFilter.increment([0]);
      }

      // falcon magic sauce
      filter.cumulativeSum();
    } else if (view instanceof View1D) {
      if (view.dimension.type === "continuous") {
        // bins for passive view that we accumulate across
        const dim = view.dimension;
        const binConfig = dim.binConfig!;
        const bin = binNumberFunctionContinuous(binConfig);
        const binCount = numBinsContinuous(binConfig);

        filter = FalconArray.allocCumulative(numPixels * binCount, [
          numPixels,
          binCount,
        ]);
        noFilter = FalconArray.allocCounts(binCount, [binCount]);

        const column = this.data.getChild(dim.name)!;

        // add data to aggregation matrix
        for (let i = 0; i < this.data.numRows; i++) {
          // ignore filtered entries
          if (filterMask && filterMask.get(i)) {
            continue;
          }

          const key = bin(column.get(i)!);
          const keyActive = binActive(activeCol.get(i)!) + 1;
          if (0 <= key && key < binCount) {
            if (0 <= keyActive && keyActive < numPixels) {
              filter.increment([keyActive, key]);
            }
            noFilter.increment([key]);
          }
        }

        for (
          let passiveBinIndex = 0;
          passiveBinIndex < filter.shape[1];
          passiveBinIndex++
        ) {
          // sum across column (passive bin aggregate)
          filter.slice(null, passiveBinIndex).cumulativeSum();
        }
      } else {
        throw Error("categorical not implemented yet");
      }
    } else {
      throw Error("only 0D and 1D views");
    }

    return {
      noFilter,
      filter,
    };
  }

  /**
   * given the dimension and filters
   *
   * @returns a map of the filter masks
   */
  private getFilterMasks(filters: Filters): FilterMasks<Dimension> {
    // no filters just return blank
    if (!filters.size) {
      return new Map();
    }

    // extract filters from the larger cache index into this compact one
    const compactIndex: FilterMasks<Dimension> = new Map();
    for (const [dimension, filter] of filters) {
      let mask: BitSet;
      if (dimension.type === "continuous") {
        mask = this.getContinuousFilterMask(
          dimension,
          filter as ContinuousRange
        )!;
      } else {
        mask = this.getCategoricalFilterMask(
          dimension,
          filter as CategoricalRange
        )!;
      }
      compactIndex.set(dimension, mask);
    }

    return compactIndex;
  }

  /**
   * Gets filter mask given the filter (extent for now)
   *
   * @returns a bitmask of which 1 if the row value should be included or 0 if not
   */
  private getCategoricalFilterMask(
    dimension: CategoricalDimension,
    filter: CategoricalRange
  ) {
    const filterSet = new Set(filter);
    const key = `${dimension.name} ${filter}`;

    // if not in the cache, compute it and add it!
    const notFound = !this.filterMaskIndex.has(key);
    if (notFound) {
      // compute filter mask
      const column = this.data.getChild(dimension.name)!;
      const mask = arrowFilterMask(
        column,
        (value: any) => !filterSet.has(value)
      );

      // set the cache
      this.filterMaskIndex.set(key, mask);
    }

    // return the value of the mask
    return this.filterMaskIndex.get(key);
  }

  /**
   * Gets filter mask given the filter (extent for now)
   *
   * @returns a bitmask of which 1 if the row value should be included or 0 if not
   */
  private getContinuousFilterMask(
    dimension: ContinuousDimension,
    filter: ContinuousRange
  ) {
    const key = `${dimension.name} ${filter}`;

    // if not in the cache, compute it and add it!
    const notFound = !this.filterMaskIndex.has(key);
    if (notFound) {
      // compute filter mask
      const column = this.data.getChild(dimension.name)!;
      const mask = arrowFilterMask(
        column,
        (value: number) => value < filter[0] || value >= filter[1]
      );

      // set the cache
      this.filterMaskIndex.set(key, mask);
    }

    // return the value of the mask
    return this.filterMaskIndex.get(key);
  }
}
/**
 * given an arrow column vector, create a filter mask
 *
 * @note uses bitmask to reduce space and allow for potential computer optimizations
 * @note should filter => true corresponds to filter out and false keeps
 * @returns a bitmask that indicates if the values should be included (1) or not (0)
 */
function arrowFilterMask<T>(
  column: Vector,
  shouldFilterOut: (rowValue: T) => boolean
) {
  const bitmask = new BitSet(column.length);

  /**
   * iterate each row value in the column and decide if we should
   * keep it or not
   *
   * bit 1 indicates filter
   * bit 0 indicates keep
   */
  for (let i = 0; i < column.length; i++) {
    const rowValue: T = column.get(i)!;
    if (shouldFilterOut(rowValue)) {
      bitmask.set(i, true);
    }
  }

  return bitmask;
}

/**
 * Takes all unique values and returns it into an array
 *
 * @returns unique values in an array
 */
function arrowColumnUnique(column: Vector): any[] {
  const unique = new Set();
  for (const rowValue of column) {
    unique.add(rowValue);
  }
  return Array.from(unique);
}

/**
 * extent over a single columnar vector from arrow
 *
 * @returns the [min, max] of the column values
 */
function arrowColumnExtent(column: Vector): Interval<number> {
  const firstRowValue: number = column.get(0)!;
  let max = firstRowValue;
  let min = firstRowValue;

  for (const rowValue of column) {
    // if we found something BIGGER the max, that should be the max instead!
    if (rowValue > max) {
      max = rowValue;
    }
    // if we found something SMALLER the min, that should be the min instead!
    else if (rowValue < min) {
      min = rowValue;
    }
  }

  return [min, max];
}
