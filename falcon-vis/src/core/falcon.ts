import { View0D, View1D, ViewSet, View1DState, View0DState } from "./views";
import { excludeMap } from "./util";
import type { Dimension } from "./dimension";
import type { FalconDB, FalconIndex, Filters } from "./db/db";
import type { OnChange } from "./views/viewAbstract";

export class Falcon {
  db: FalconDB;
  views: ViewSet;
  filters: Filters;
  index: FalconIndex;

  /**
   * Takes a data and creates the main driver of the Falcon library
   *
   * Here, you can then create new views (view0D or view1D) and directly interact with
   * those
   */
  constructor(db: FalconDB) {
    this.db = db;
    this.views = new ViewSet();
    this.filters = new Map();
    this.index = new Map();
  }

  /**
   * @returns the filters and excludes the active view dimension's filters
   */
  get passiveFilters(): Filters {
    const activeView = this.views.active;
    if (activeView instanceof View0D) {
      throw Error("No filter for 0D view / count");
    } else if (activeView instanceof View1D) {
      const onlyPassiveFilters = excludeMap(this.filters, activeView.dimension);
      return onlyPassiveFilters;
    } else {
      throw Error("2D view not implemented yet");
    }
  }

  /**
   * add 0D view, does not initialize the view
   */
  view0D(onChange?: OnChange<View0DState>) {
    const view = new View0D(this);
    this.views.add(view);

    if (onChange) {
      view.addOnChangeListener(onChange);
    }

    return view;
  }

  /**
   * Creates a 0D view that counts the number of entries
   *
   * @returns the view
   */
  count(onChange?: OnChange<View0DState>) {
    return this.view0D(onChange);
  }

  /**
   * add 1D view, does not initialize the view
   *
   * @returns the 1D view you can directly filter with .select()
   */
  view1D(dimension: Dimension, onChange?: OnChange<View1DState>) {
    const view = new View1D(this, dimension);
    this.views.add(view);

    if (onChange) {
      view.addOnChangeListener(onChange);
    }

    return view;
  }

  /**
   * links dimensions together to form a view
   * this also links the view with all the other views
   *
   * @todo add 2D and 0D capabilities to this function so this link() is a one stop shop
   * @returns the view you can directly filter with .select()
   */
  link(dimension: Dimension, onChange?: OnChange<View1DState>) {
    return this.view1D(dimension, onChange);
  }

  /**
   * @returns an iterable that iterates over instances from the filter
   */
  async entries({ offset = 0, length = Infinity } = {}) {
    return this.db.entries(offset, length, this.filters);
  }

  /**
   * Fetches the initial counts for all the views
   * This does not involve fetching the falcon index
   */
  async all() {
    this.views.forEach(async (view) => {
      await view.all();
    });
  }
}