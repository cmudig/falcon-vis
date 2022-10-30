import type {
    Dimension,
    View as ViewSpec,
    Views as ViewsSpecs,
    View1D as ViewSpec1D,
    View2D as ViewSpec2D,
} from "../api";
import { Interval } from "../basic";
import type { DataBase, Index } from "../db/index";
import { binTime, bin, sub, summedAreaTableLookup, extent } from "../util";
import { NdArray } from "ndarray";

/**
 * Falcon object that deals with the data
 * and keeps track of all the views
 */
export class FalconGlobal<V extends string, D extends string> {
    public db: DataBase<V, D>;
    dbReady: boolean;
    views: FalconView<V, D>[];
    dataCube: Index<V> | null;
    constructor(db: DataBase<V, D>) {
        this.db = db;
        this.dbReady = false;
        this.views = [];
        this.dataCube = null;
    }

    loadData1D(
        activeView: ViewSpec1D<D>,
        pixels: number,
        views: ViewsSpecs<V, D>,
        brushes: Brushes<D>
    ) {
        this.dataCube = this.db.loadData1D(activeView, pixels, views, brushes);
    }
    loadData2D(
        activeView: ViewSpec2D<D>,
        pixels: [number, number],
        views: ViewsSpecs<V, D>,
        brushes: Brushes<D>
    ) {
        this.dataCube = this.db.loadData2D(activeView, pixels, views, brushes);
    }

    async initDB() {
        if (this.db) {
            await this.db.initialize();
            this.dbReady = true;
        } else {
            throw Error("Make sure you have loaded the db in the constructor");
        }
    }
    async add(...views: FalconView<V, D>[]) {
        for (const view of views) {
            await this.addSingleView(view);
        }
    }
    async addSingleView(view: FalconView<V, D>) {
        if (!this.dbReady) {
            await this.initDB();
        }

        // connect the view to the data and do initial counts
        view.giveAccessToFalcon(this);
        // keep track of views on this global object
        this.views.push(view);
        await view.initialize();
    }
    async buildFalconIndex() {
        //
    }
    async updatePassiveCounts() {
        //
    }
    get brushes(): Brushes<D> {
        return dimNameToBrushMap(this.views);
    }
}

type OnUpdate<T> = (updatedState: T) => void;
type Brush = Interval<number>;
type Brushes<DimensionName> = Map<DimensionName, Brush>;

/**
 * Falcon view that deals with the dimensions
 * and user interaction
 */
export class FalconView<V extends string, D extends string> {
    falcon!: FalconGlobal<V, D>;
    spec: ViewSpec<D>;
    onUpdate: OnUpdate<object>;
    isActive: boolean;
    name: V;
    brushes: Brushes<D>;
    constructor(spec: ViewSpec<D>, onUpdate: OnUpdate<object>) {
        this.spec = spec;
        this.onUpdate = onUpdate;
        this.isActive = false;
        this.name = createViewNameFromSpec(spec) as V;
        this.brushes = new Map();
    }

    /**
     * since we have no idea which chart will become the active
     * just show the initial counts to start
     */
    async initialize() {
        this.verifyFalconAccess();

        const { db } = this.falcon;

        let data: any = null;
        if (this.spec.type === "1D") {
            const { dimension } = this.spec;

            const inferExtent =
                dimension.extent ?? (await db.getDimensionExtent(dimension));
            dimension.binConfig = createBinConfig(dimension, inferExtent);
            const { hist } = await db.histogram(dimension);
            data = hist;
        } else if (this.spec.type === "2D") {
            const { dimensions } = this.spec;

            // bin config on each dimension
            for (const dimension of dimensions) {
                const inferExtent =
                    dimension.extent ??
                    (await db.getDimensionExtent(dimension));
                dimension.binConfig = createBinConfig(dimension, inferExtent);
            }

            const heatmapData = db.heatmap(dimensions);
            data = heatmapData;
        } else if (this.spec.type === "0D") {
            const totalCount = db.length();
            data = totalCount;
        } else {
            throw Error("Number of dimensions must be 0D 1D or 2D");
        }

        // EPIC! now we can update the user with the initial data
        /**
         * @TODO send them a nice array of {bin: the actual bin description, count: num, filteredCount: num}
         */
        this.onUpdate({ data });
    }

    /**
     * Fetches the falcon index where this view is the active one
     * and rest are passive
     */
    prefetch() {
        // and 0D has no prefetch mechanic

        /**
         * if already an active view, no need to prefetch anything
         * but, if not active, make active and fetch the index for the falcon magic
         */
        if (!this.isActive && this.spec.type !== "0D") {
            // make this the active view
            this.makeActiveView();
            const activeView = this.spec;

            const passiveViews = nameToViewSpecMap(this.otherViews);
            const passiveBrushes = dimNameToBrushMap(this.otherViews);
            const pixels = getResFromSpec(this.spec);

            if (activeView.type === "1D") {
                this.falcon.loadData1D(
                    activeView,
                    pixels as number,
                    passiveViews,
                    passiveBrushes
                );
            } else if (activeView.type === "2D") {
                this.falcon.loadData2D(
                    activeView,
                    pixels as [number, number],
                    passiveViews,
                    passiveBrushes
                );
            }

            // now I have all the info to update the data cube
            console.log(
                activeView,
                passiveViews,
                passiveBrushes,
                pixels,
                this.falcon.dataCube
            );
        }
    }

    /**
     * Filters the data by the specified brush interactively
     * then calls onUpdate when finished
     */
    interact(brush: Brush | Brush[]) {
        //1. set brush for the current view
        this.setBrush(brush);

        //2. if this was not prefetched, prefetch dummy!
        if (!this.isActive) {
            this.prefetch();
        }

        //3. use the data cube computed in prefetch
        //   to compute the passive counts
        if (this.spec.type === "1D") {
            this.update1DActiveView(
                this.falcon.dataCube!,
                this.getBrushes() as Brush
            );
        } else if (this.spec.type === "2D") {
            throw Error("not implemented counting from 2D active view");
        }
    }

    getBrushes() {
        if (this.spec.type === "1D") {
            return this.brushes.get(this.spec.dimension.name)!;
        } else if (this.spec.type === "2D") {
            return this.spec.dimensions.map((dim) => {
                return this.brushes.get(dim.name)!;
            });
        } else {
            throw Error();
        }
    }

    /**
     * This function assumes that the active view calls it
     */
    async update1DActiveView(dataCube: Index<V>, activeBrush: Brush) {
        if (!this.isActive) {
            throw Error("Active view can only call this function");
        }

        // we get the current brush 1D and make sure its in monotonic increasing order
        const activeBrushFloat = extent(activeBrush);
        // we floor the 1D brush so its not a repeating fractional value
        const activeBrushFloor = [
            Math.floor(activeBrushFloat[0]),
            Math.floor(activeBrushFloat[1]),
        ] as Brush;

        // for all the other views (passive views), first figure out type of passive
        // then get the updated counts for each passive view
        for (const passiveView of this.otherViews) {
            const passiveType = passiveView.spec.type;
            const { hists, noBrush } = await dataCube.get(passiveView.name)!;

            if (passiveType === "0D") {
                const value = activeBrushFloat
                    ? valueFor1D(hists, activeBrushFloor)
                    : noBrush.get(0);
            } else if (passiveType === "1D") {
                const hist = activeBrushFloat
                    ? histFor1D(hists, activeBrushFloor)
                    : noBrush;
            } else if (passiveType === "2D") {
                const heat = activeBrushFloat
                    ? heatFor1D(hists, activeBrushFloor)
                    : noBrush;
            }
        }
    }

    setBrush(brush: Brush | Brush[]) {
        const { type } = this.spec;
        const firstEntryIsArray = Array.isArray(brush[0]);
        if (type === "1D" && !firstEntryIsArray) {
            const { dimension } = this.spec;
            this.brushes.set(dimension.name, brush as Brush);
        } else if (type === "2D" && firstEntryIsArray) {
            const { dimensions } = this.spec;
            dimensions.forEach((dimension, i) => {
                this.brushes.set(dimension.name, brush[i] as Brush);
            });
        } else {
            throw Error("either brush passed in is wrong size or type wrong");
        }
    }

    giveAccessToFalcon(falcon: FalconGlobal<V, D>) {
        this.falcon = falcon;
    }
    verifyFalconAccess(throwError = true) {
        const falconDataExists = this.falcon !== undefined;
        if (!falconDataExists && throwError) {
            console.error("Bad Falcon connection in", this.spec);
            throw Error("View contains no falcon global object");
        }
        return falconDataExists;
    }
    makeActiveView() {
        this.isActive = true;
        this.otherViews.forEach((view) => (view.isActive = false));
    }
    get otherViews(): FalconView<V, D>[] {
        return this.falcon.views.filter((view) => view !== this);
    }
}

function createBinConfig<D extends string>(
    dimension: Dimension<D>,
    extent: Interval<number>
) {
    const binningFunc = dimension.time ? binTime : bin;
    return binningFunc(dimension.bins, extent);
}

/**
 * Takes FalconView and shuvs the view spec (the old view type)
 * into a map from view name to view spec
 *
 * @TODO remove this, this is a spandrel from using the old db code
 * needing to pass in a map of views
 */
function nameToViewSpecMap<V extends string, D extends string>(
    views: FalconView<V, D>[]
): ViewsSpecs<V, D> {
    const nameToViewSpec = new Map();
    views.forEach((view) => {
        nameToViewSpec.set(view.name, view.spec);
    });
    return nameToViewSpec;
}

/**
 * @TODO remove view names altogether
 * this functions covers up a spandrel of using the old
 * db code
 * Might need to use a unique id here given the map
 */
function createViewNameFromSpec<D extends string>(spec: ViewSpec<D>) {
    if (spec.type === "0D") {
        return "TOTAL";
    } else if (spec.type === "1D") {
        return spec.dimension.name.toString();
    } else if (spec.type === "2D") {
        return spec.dimensions.reduce((acc, dimension) => {
            return `${acc}*${dimension.name.toString()}`;
        }, "");
    } else {
        throw Error("Type is something other than 0D, 1D or 2D");
    }
}

/**
 * Get a map of brushes mapping dimension to brush
 * This is used to take the passive views and construct the map of brushes
 */
function dimNameToBrushMap<V extends string, D extends string>(
    views: FalconView<V, D>[]
) {
    const separateBrushes = views.map((view) => view.brushes);
    const allBrushes: Brushes<D> = unionMaps(separateBrushes);
    return allBrushes;
}

function unionMaps<K, V>(mapObjs: Map<K, V>[]) {
    let entries: [K, V][] = [];
    for (const obj of mapObjs) {
        for (const entry of obj.entries()) {
            entries.push(entry);
        }
    }
    return new Map(entries);
}

function getResFromSpec<D extends string>(spec: ViewSpec<D>) {
    if (spec.type === "1D") {
        return spec.dimension.resolution;
    } else if (spec.type === "2D") {
        return [...spec.dimensions.map((d) => d.resolution)];
    }
}

/**
 * Functions that compute counts from the data cube index
 */

/**
 * Takes active view 1D index and brush and computes passive 0D count
 */
function valueFor1D(hists: NdArray, floor: Interval<number>) {
    return hists.get(floor[1]) - hists.get(floor[0]);
}

/**
 * Takes active view 1D index and brush and computes passive 1D counts
 */
function histFor1D(hists: NdArray, floor: Interval<number>) {
    return sub(hists.pick(floor[0], null), hists.pick(floor[1], null));
}

/**
 * Takes active view 1D index and brush and computes passive 2D counts
 */
function heatFor1D(hists: NdArray, floor: Interval<number>) {
    return sub(
        hists.pick(floor[0], null, null),
        hists.pick(floor[1], null, null)
    );
}

/**
 * Takes active view 2D index and brush and computes passive 0D count
 */
function valueFor2D(hists: NdArray, floor: Interval<Interval<number>>) {
    return (
        hists.get(floor[0][1], floor[1][1]) -
        hists.get(floor[0][1], floor[1][0]) -
        hists.get(floor[0][0], floor[1][1]) +
        hists.get(floor[0][0], floor[1][0])
    );
}

/**
 * Takes active view 2D index and brush and computes passive 1D counts
 */
function histFor2D(hists: NdArray, floor: Interval<Interval<number>>) {
    return summedAreaTableLookup(
        hists.pick(floor[0][1], floor[1][1], null),
        hists.pick(floor[0][1], floor[1][0], null),
        hists.pick(floor[0][0], floor[1][1], null),
        hists.pick(floor[0][0], floor[1][0], null)
    );
}

/**
 * Takes active view 2D index and brush and computes passive 2D counts
 */
function heatFor2D(hists: NdArray, floor: Interval<Interval<number>>) {
    return summedAreaTableLookup(
        hists.pick(floor[0][1], floor[1][1], null, null),
        hists.pick(floor[0][1], floor[1][0], null, null),
        hists.pick(floor[0][0], floor[1][1], null, null),
        hists.pick(floor[0][0], floor[1][0], null, null)
    );
}
