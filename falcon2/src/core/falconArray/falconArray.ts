import { CumulativeCountsArray, CountsArray } from "./arrayTypes";
import ndarray from "ndarray";
import prefixSum from "ndarray-prefix-sum";
import ops from "ndarray-ops";
import type { TypedArray, TypedArrayConstructor } from "./arrayTypes";
import type { NdArray } from "ndarray";

/**
 * abstract away the NdArray reliance and can be swapped out
 * for std lib js for example or vanilla, or tensorflow.js?
 *
 * @resource [PyTorch example of shape, stride, offset](https://www.youtube.com/watch?v=85xBkapaZts)
 */
export class FalconArray {
  ndarray: NdArray;
  data: TypedArray;

  constructor(
    data: TypedArray,
    shape?: number[],
    strides?: number[],
    offset?: number
  ) {
    this.data = data;
    this.ndarray = ndarray(data, shape, strides, offset);
  }

  /**
   * these GETS AND SETS can be replaced with
   * variables on the object when we phase out ndarray
   */
  get shape() {
    return this.ndarray.shape;
  }
  get offset() {
    return this.ndarray.offset;
  }
  get strides() {
    return this.ndarray.stride;
  }
  get length() {
    return this.ndarray.size;
  }
  set shape(value: number[]) {
    this.ndarray.shape = value;
  }
  set offset(value: number) {
    this.ndarray.offset = value;
  }
  set strides(value: number[]) {
    this.ndarray.stride = value;
  }
  get(...indices: number[]) {
    return this.ndarray.get(...indices);
  }
  set(...indices: number[]) {
    return this.ndarray.set(...indices);
  }
  fill(value: number) {
    this.data.fill(value);
  }

  /**
   * increments the location defined by index by
   * whatever you want!
   */
  increment(index: number[], incrementBy = 1) {
    this.set(...index, this.get(...index) + incrementBy);
    return this;
  }

  /**
   * this + other and overrides this memory
   */
  addToItself(other: FalconArray): this {
    ops.addeq(this.ndarray, other.ndarray);
    return this;
  }

  /**
   * this - other and overrides this memory
   */
  subToItself(other: FalconArray): this {
    ops.subeq(this.ndarray, other.ndarray);
    return this;
  }

  /**
   * this - other = new memory
   */
  sub(other: FalconArray, ReturnArray = CountsArray): FalconArray {
    const out = new FalconArray(new ReturnArray(this.length), this.shape);
    ops.sub(out.ndarray, this.ndarray, other.ndarray);
    return out;
  }

  /**
   * slice by changing the shape, offset, or stride
   * no new memory created
   */
  slice(...indices: (number | null)[]): FalconArray {
    const sliced = this.ndarray.pick(...indices);
    return new FalconArray(
      this.data,
      sliced.shape,
      sliced.stride,
      sliced.offset
    );
  }

  /**
   * prefix sum across and up
   */
  cumulativeSum(): this {
    prefixSum(this.ndarray);
    return this;
  }

  /**
   * @returns FalconArray with typed array
   */
  private static typedArray(
    TypedArray: TypedArrayConstructor,
    length: number,
    shape?: number[],
    stride?: number[],
    offset?: number
  ): FalconArray {
    const newMemory = new TypedArray(length);
    return new FalconArray(newMemory, shape, stride, offset);
  }

  /**
   * Typed array to store and accumulate values
   * Float for this, but consider other options
   *
   * Namely for the cubes
   *
   * @returns FalconArray with the given length allocated
   */
  static allocCumulative(
    length: number,
    shape?: number[],
    stride?: number[],
    offset?: number
  ): FalconArray {
    return this.typedArray(
      CumulativeCountsArray,
      length,
      shape,
      stride,
      offset
    );
  }

  /**
   * Typed array to store integer counts. Namely the histogram bins and counts.
   *
   * @returns FalconArray with the given length allocated
   */
  static allocCounts(
    length: number,
    shape?: number[],
    stride?: number[],
    offset?: number
  ): FalconArray {
    return this.typedArray(CountsArray, length, shape, stride, offset);
  }
}
