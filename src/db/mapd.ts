import "@mapd/connector/dist/browser-connector";
import ndarray from "ndarray";
import prefixSum from "ndarray-prefix-sum";
import { Dimension, View1D, View2D, Views } from "../api";
import { Interval } from "../basic";
import { numBins, stepSize } from "../util";
import { BinConfig } from "./../api";
import { CUM_ARR_TYPE, HIST_TYPE } from "./../consts";
import { DataBase, Cubes } from "./db";

const connector = new (window as any).MapdCon();

export class MapDDB<V extends string, D extends string>
  implements DataBase<V, D> {
  private session: any;

  public readonly blocking: boolean = false;

  constructor(
    private readonly conn: {
      host: string;
      db: string;
      user: string;
      password: string;
    },
    private readonly table: string,
    private readonly nameMap: Map<D, string>
  ) {}

  public async initialize() {
    const connection = connector
      .protocol("https")
      .host(this.conn.host)
      .port("443")
      .dbName(this.conn.db)
      .user(this.conn.user)
      .password(this.conn.password);

    this.session = await connection.connectAsync();
  }

  private async query(q: string): Promise<any[]> {
    const t0 = Date.now();

    const {
      results,
      timing
      // fields
    } = await this.session.queryAsync(q, {
      returnTiming: true
    });

    q = q.replace(/\s\s+/g, " ").trim();

    console.info(
      "%c" + q,
      "color: #bbb",
      "\nRows:",
      results.length,
      "Execution time:",
      timing.execution_time_ms,
      "ms. Total time:",
      timing.total_time_ms,
      "ms. With network:",
      Date.now() - t0,
      "ms."
    );

    return results;
  }

  private binSQL(dimension: D, binConfig: BinConfig) {
    const field = this.nameMap.get(dimension)!;
    return {
      select: `floor(
        (${field} - cast(${binConfig.start} as float))
        / cast(${binConfig.step} as float))`,
      where: `${field} BETWEEN ${binConfig.start} AND ${binConfig.stop}`
    };
  }

  public async length() {
    const result = await this.query(
      `SELECT count(*) AS cnt FROM ${this.table}`
    );

    return result[0].cnt;
  }

  public async histogram(dimension: Dimension<D>) {
    const bin = dimension.binConfig!;
    const binCount = numBins(bin);
    const bSql = this.binSQL(dimension.name, bin);

    const hist = ndarray(new HIST_TYPE(binCount));

    const result = await this.query(`
      SELECT
        ${bSql.select} AS key,
        count(*) AS cnt
      FROM ${this.table}
      WHERE ${bSql.where}
      GROUP BY key
      `);

    for (const { key, cnt } of result) {
      hist.set(key, cnt);
    }

    return hist;
  }

  public async heatmap(dimensions: [Dimension<D>, Dimension<D>]) {
    const [binX, binY] = dimensions.map(d => d.binConfig!);
    const [numBinsX, numBinsY] = [binX, binY].map(numBins);
    const bSqlX = this.binSQL(dimensions[0].name, binX);
    const bSqlY = this.binSQL(dimensions[1].name, binY);

    const heat = ndarray(new HIST_TYPE(numBinsX * numBinsY), [
      numBinsX,
      numBinsY
    ]);

    const result = await this.query(`
      SELECT
        ${bSqlX.select} AS keyX,
        ${bSqlY.select} AS keyY,
        count(*) AS cnt
      FROM ${this.table}
      WHERE
        ${bSqlX.where} AND ${bSqlY.where}
      GROUP BY keyX, keyY
      `);

    for (const { keyX, keyY, cnt } of result) {
      heat.set(keyX, keyY, cnt);
    }

    return heat;
  }

  private getWhereClauses(brushes: Map<D, Interval<number>>) {
    const filters = new Map<D, string>();

    for (const [dimension, extent] of brushes) {
      const field = this.nameMap.get(dimension)!;
      filters.set(dimension, `${field} BETWEEN ${extent[0]} AND ${extent[1]}`);
    }

    return filters;
  }

  public async loadData1D(
    activeView: View1D<D>,
    pixels: number,
    views: Views<V, D>,
    brushes: Map<D, Interval<number>>
  ) {
    const t0 = Date.now();

    const filters = this.getWhereClauses(brushes);
    const cubes: Cubes<V> = new Map();

    const activeDim = activeView.dimension;
    const activeStepSize = stepSize(activeDim.extent, pixels);
    const binActive = this.binSQL(activeDim.name, {
      start: activeDim.extent[0] - activeStepSize,
      step: activeStepSize,
      stop: activeDim.extent[1]
    });

    const numPixels = pixels + 1; // extending by one pixel so we can compute the right diff later

    await Promise.all(
      Array.from(views.entries()).map(async ([name, view]) => {
        let hists: ndarray;
        let noBrush: ndarray;

        const relevantFilters = new Map(filters);
        if (view.type === "0D") {
          // use all filters
        } else if (view.type === "1D") {
          relevantFilters.delete(view.dimension.name);
        } else {
          relevantFilters.delete(view.dimensions[0].name);
          relevantFilters.delete(view.dimensions[1].name);
        }

        const where = Array.from(relevantFilters.values()).join(" AND ");

        let query: string;

        const select = `CASE
            WHEN ${binActive.where}
            THEN ${binActive.select}
            ELSE -1 END AS keyActive,
          count(*) AS cnt`;

        if (view.type === "0D") {
          hists = ndarray(new CUM_ARR_TYPE(numPixels));
          noBrush = ndarray(new HIST_TYPE(1), [1]);

          query = `
          SELECT
            ${select}
          FROM ${this.table}
          ${where ? `WHERE ${where}` : ""}
          GROUP BY keyActive`;
        } else if (view.type === "1D") {
          const dim = view.dimension;

          const binConfig = dim.binConfig!;
          const bin = this.binSQL(dim.name, binConfig);
          const binCount = numBins(binConfig);

          hists = ndarray(new CUM_ARR_TYPE(numPixels * binCount), [
            numPixels,
            binCount
          ]);
          noBrush = ndarray(new HIST_TYPE(binCount), [binCount]);

          query = `
          SELECT
            ${select},
            ${bin.select} AS key
          FROM ${this.table}
          WHERE ${bin.where} ${where ? `AND ${where}` : ""}
          GROUP BY keyActive, key`;
        } else {
          const dimensions = view.dimensions;
          const binConfigs = dimensions.map(d => d.binConfig!);
          const [numBinsX, numBinsY] = binConfigs.map(numBins);
          const [binX, binY] = [0, 1].map(i =>
            this.binSQL(dimensions[i].name, binConfigs[i])
          );

          hists = ndarray(new CUM_ARR_TYPE(numPixels * numBinsX * numBinsY), [
            numPixels,
            numBinsX,
            numBinsY
          ]);
          noBrush = ndarray(new HIST_TYPE(numBinsX * numBinsY), [
            numBinsX,
            numBinsY
          ]);

          query = `
          SELECT
            ${select},
            ${binX.select} as keyX,
            ${binY.select} as keyY
          FROM ${this.table}
          WHERE ${binX.where} AND ${binY.where} ${where ? `AND ${where}` : ""}
          GROUP BY keyActive, keyX, keyY`;
        }

        const res = await this.query(query);

        if (view.type === "0D") {
          for (const { keyActive, cnt } of res) {
            if (keyActive >= 0) {
              hists.set(keyActive, cnt);
            }
            noBrush.data[0] += cnt;
          }

          prefixSum(hists);
        } else if (view.type === "1D") {
          for (const { keyActive, key, cnt } of res) {
            if (keyActive >= 0) {
              hists.set(keyActive, key, cnt);
            }
            noBrush.data[noBrush.index(key)] += cnt;
          }

          // compute cumulative sums
          for (let x = 0; x < hists.shape[1]; x++) {
            prefixSum(hists.pick(null, x));
          }
        } else if (view.type === "2D") {
          for (const { keyActive, keyX, keyY, cnt } of res) {
            if (keyActive >= 0) {
              hists.set(keyActive, keyX, keyY, cnt);
            }
            noBrush.data[noBrush.index(keyX, keyY)] += cnt;
          }

          // compute cumulative sums
          for (let x = 0; x < hists.shape[1]; x++) {
            for (let y = 0; y < hists.shape[2]; y++) {
              prefixSum(hists.pick(null, x, y));
            }
          }
        }

        cubes.set(name, { hists, noBrush });
      })
    );

    console.info(`Build result cube: ${Date.now() - t0}ms`);

    return cubes;
  }

  public async loadData2D(
    activeView: View2D<D>,
    pixels: [number, number],
    views: Views<V, D>,
    brushes: Map<D, Interval<number>>
  ) {
    const t0 = Date.now();

    const filters = this.getWhereClauses(brushes);
    const cubes: Cubes<V> = new Map();

    const [activeDimX, activeDimY] = activeView.dimensions;
    const activeStepSizeX = stepSize(activeDimX.extent, pixels[0]);
    const activeStepSizeY = stepSize(activeDimY.extent, pixels[1]);
    const binActiveX = this.binSQL(activeDimX.name, {
      start: activeDimX.extent[0] - activeStepSizeX,
      step: activeStepSizeX,
      stop: activeDimX.extent[1]
    });
    const binActiveY = this.binSQL(activeDimY.name, {
      start: activeDimY.extent[0] - activeStepSizeY,
      step: activeStepSizeY,
      stop: activeDimY.extent[1]
    });

    const [numPixelsX, numPixelsY] = [pixels[0] + 1, pixels[1] + 1];

    await Promise.all(
      Array.from(views.entries()).map(async ([name, view]) => {
        let hists: ndarray;
        let noBrush: ndarray;

        const relevantFilters = new Map(filters);
        if (view.type === "0D") {
          // use all filters
        } else if (view.type === "1D") {
          relevantFilters.delete(view.dimension.name);
        } else {
          relevantFilters.delete(view.dimensions[0].name);
          relevantFilters.delete(view.dimensions[1].name);
        }

        const where = Array.from(relevantFilters.values()).join(" AND ");

        let query: string;

        const select = `CASE
            WHEN ${binActiveX.where} AND ${binActiveY.where}
            THEN ${binActiveX.select}
            ELSE -1 END AS keyActiveX,
          CASE
            WHEN ${binActiveX.where} AND ${binActiveY.where}
            THEN ${binActiveY.select}
            ELSE -1 END AS keyActiveY,
          count(*) AS cnt`;

        if (view.type === "0D") {
          hists = ndarray(new CUM_ARR_TYPE(numPixelsX * numPixelsY), [
            numPixelsX,
            numPixelsY
          ]);
          noBrush = ndarray(new HIST_TYPE(1), [1]);

          query = `
          SELECT
            ${select}
          FROM ${this.table}
          ${where ? `WHERE ${where}` : ""}
          GROUP BY keyActiveX, keyActiveY`;
        } else if (view.type === "1D") {
          const dim = view.dimension;

          const binConfig = dim.binConfig!;
          const bin = this.binSQL(dim.name, binConfig);
          const binCount = numBins(binConfig);

          hists = ndarray(
            new CUM_ARR_TYPE(numPixelsX * numPixelsY * binCount),
            [numPixelsX, numPixelsY, binCount]
          );
          noBrush = ndarray(new HIST_TYPE(binCount), [binCount]);

          query = `
          SELECT
            ${select},
            ${bin.select} AS key
          FROM ${this.table}
          WHERE ${bin.where} ${where ? `AND ${where}` : ""}
          GROUP BY keyActiveX, keyActiveY, key`;
        } else {
          const dimensions = view.dimensions;
          const binConfigs = dimensions.map(d => d.binConfig!);
          const [numBinsX, numBinsY] = binConfigs.map(numBins);
          const [binX, binY] = [0, 1].map(i =>
            this.binSQL(dimensions[i].name, binConfigs[i])
          );

          hists = ndarray(
            new CUM_ARR_TYPE(numPixelsX * numPixelsY * numBinsX * numBinsY),
            [numPixelsX, numPixelsY, numBinsX, numBinsY]
          );
          noBrush = ndarray(new HIST_TYPE(numBinsX * numBinsY), [
            numBinsX,
            numBinsY
          ]);

          query = `
          SELECT
            ${select},
            ${binX.select} AS keyX,
            ${binY.select} AS keyY
          FROM ${this.table}
          WHERE ${binX.where} AND ${binY.where} ${where ? `AND ${where}` : ""}
          GROUP BY keyActiveX, keyActiveY, keyX, keyY`;
        }

        const res = await this.query(query);

        if (view.type === "0D") {
          for (const { keyActiveX, keyActiveY, cnt } of res) {
            if (keyActiveX >= 0 && keyActiveY >= 0) {
              hists.set(keyActiveX, keyActiveY, cnt);
            }
            noBrush.data[0] += cnt;
          }

          prefixSum(hists);
        } else if (view.type === "1D") {
          for (const { keyActiveX, keyActiveY, key, cnt } of res) {
            if (keyActiveX >= 0 && keyActiveY >= 0) {
              hists.set(keyActiveX, keyActiveY, key, cnt);
            }
            noBrush.data[noBrush.index(key)] += cnt;
          }

          // compute cumulative sums
          for (let x = 0; x < hists.shape[2]; x++) {
            prefixSum(hists.pick(null, null, x));
          }
        } else if (view.type === "2D") {
          for (const { keyActiveX, keyActiveY, keyX, keyY, cnt } of res) {
            if (keyActiveX >= 0 && keyActiveY >= 0) {
              hists.set(keyActiveX, keyActiveY, keyX, keyY, cnt);
            }
            noBrush.data[noBrush.index(keyX, keyY)] += cnt;
          }

          // compute cumulative sums
          for (let x = 0; x < hists.shape[2]; x++) {
            for (let y = 0; y < hists.shape[3]; y++) {
              prefixSum(hists.pick(null, null, x, y));
            }
          }
        }

        cubes.set(name, { hists, noBrush });
      })
    );

    console.info(`Build result cube: ${Date.now() - t0}ms`);

    return cubes;
  }
}
