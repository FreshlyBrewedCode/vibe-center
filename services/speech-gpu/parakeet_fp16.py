"""Convert the Parakeet-TDT ONNX encoder (fp32, 2.4 GB) to fp16 with fp32 inputs/outputs.
usage: python parakeet_fp16.py <model-dir>   writes encoder-model.fp16.onnx(+.data) and
decoder_joint-model.fp16.onnx (a copy of the fp32 decoder: it is small and latency-neutral)"""
import os, shutil, sys, warnings, onnx
from onnxconverter_common import float16

warnings.filterwarnings("ignore")
d = sys.argv[1]
# the converter needs every tensor's type; the >2 GB model needs the path-based shape inference
tmp = os.path.join(d, "encoder-model.inferred.onnx")
onnx.shape_inference.infer_shapes_path(os.path.join(d, "encoder-model.onnx"), tmp)
m = onnx.load(tmp)  # pulls in encoder-model.onnx.data
os.remove(tmp)
m16 = float16.convert_float_to_float16(m, keep_io_types=True, disable_shape_infer=True)
# the converter retypes Cast outputs to fp16 but leaves their `to=FLOAT`: make them agree
F, F16 = onnx.TensorProto.FLOAT, onnx.TensorProto.FLOAT16
vi = {v.name: v.type.tensor_type.elem_type for v in m16.graph.value_info}
for n in m16.graph.node:
    if n.op_type == "Cast" and vi.get(n.output[0]) == F16:
        for a in n.attribute:
            if a.name == "to" and a.i == F:
                a.i = F16
onnx.save_model(m16, os.path.join(d, "encoder-model.fp16.onnx"), save_as_external_data=True,
                all_tensors_to_one_file=True, location="encoder-model.fp16.onnx.data")
shutil.copy(os.path.join(d, "decoder_joint-model.onnx"), os.path.join(d, "decoder_joint-model.fp16.onnx"))
print("ok", os.path.getsize(os.path.join(d, "encoder-model.fp16.onnx.data")) >> 20, "MiB")
