import { ViewSet } from "./viewSet";
import { View0D } from "./view0D";
import { View1D } from "./view1D";
import type { View0DState } from "./view0D";
import type {
  View1DState,
  CategoricalView1DState,
  ContinuousView1DState,
} from "./view1D";

type View = View0D | View1D;

export type {
  View,
  View0DState,
  View1DState,
  CategoricalView1DState,
  ContinuousView1DState,
};
export { ViewSet, View0D, View1D };
